"""Retention sweep behaviour.

The protection set exists so the diff engine and live backfills never lose a
canonical snapshot. It must NOT shield raw artifacts (downloads / extracted /
diffs / rejected): those are pure duplication once the canonical parquet for a
version exists, and shielding them is what silently filled the PVC.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from cnpj_data_publisher.retention import RetentionService, _months_ago


def _version(months_ago: int) -> str:
    now = datetime.now(UTC)
    total = now.year * 12 + (now.month - 1) - months_ago
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def _touch(root: Path, area: str, version: str) -> Path:
    path = root / area / version
    path.mkdir(parents=True, exist_ok=True)
    (path / "payload.parquet").write_bytes(b"x")
    return path


@pytest.fixture
def svc(monkeypatch: pytest.MonkeyPatch, settings) -> RetentionService:
    """Retention service with a stubbed DB-backed protection set.

    ``dry_run=False`` so the filesystem sweep actually happens; the DB side of
    the run is stubbed out because it is out of scope here.
    """
    from contextlib import nullcontext

    import cnpj_data_publisher.retention as retention_mod

    monkeypatch.setattr(retention_mod, "session_scope", lambda: nullcontext(None))
    monkeypatch.setattr(
        retention_mod.OutboxRepository,
        "delete_published_older_than",
        lambda self, days: 0,
    )
    monkeypatch.setattr(
        retention_mod.RejectedRowRepository,
        "delete_older_than",
        lambda self, months: 0,
    )

    service = RetentionService(dry_run=False)
    # Current snapshot plus the ones the diff/backfill logic would pin. The
    # widest realistic case: the two most recent versions are protected.
    monkeypatch.setattr(
        RetentionService,
        "protected_versions",
        lambda self: {_version(0), _version(1), _version(2)},
    )
    return service


def test_raw_artifacts_are_not_shielded_by_snapshot_protection(svc: RetentionService, settings):
    """extracted/downloads follow their own window even if the snapshot is protected.

    Reproduces the production case: KEEP_EXTRACTED_FILES_MONTHS=1 puts the cutoff
    at last month, so ``extracted/<previous month>`` must be swept even though
    that same version is pinned in the snapshot protection set. Shielding it is
    precisely what left 27G per month on the PVC.
    """
    root = settings.data_root
    previous = _version(2)
    older = _version(3)
    extracted = _touch(root, "extracted", previous)
    # downloads use a wider window (KEEP_RAW_DOWNLOADS_MONTHS=2), so only the
    # version beyond that cutoff should go.
    downloads = _touch(root, "downloads", older)

    report = svc.run()

    assert previous in report.protected
    assert not extracted.exists(), "extracted CSVs of a protected snapshot must still expire"
    assert previous in report.removed_extracted
    assert not downloads.exists()
    assert older in report.removed_downloads


def test_canonical_snapshots_stay_protected(svc: RetentionService, settings):
    """A protected canonical snapshot survives even past the snapshot window."""
    root = settings.data_root
    pinned = _touch(root, "snapshots", _version(2))
    stale = _touch(root, "snapshots", _version(6))

    report = svc.run()

    assert pinned.exists(), "a protected snapshot must never be pruned"
    assert not stale.exists()
    assert _version(6) in report.removed_snapshots


def test_recent_versions_inside_window_are_kept(svc: RetentionService, settings):
    """Anything at or after the cutoff stays, regardless of the protection set."""
    root = settings.data_root
    extracted = _touch(root, "extracted", _months_ago(1))
    diffs = _touch(root, "diffs", _months_ago(1))

    report = svc.run()

    assert extracted.exists()
    assert diffs.exists()
    assert report.removed_extracted == []
    assert report.removed_diffs == []


def test_sweep_ignores_non_version_directories(svc: RetentionService, settings):
    """Stray dirs and loose files are left alone: cleanup is version-scoped."""
    root = settings.data_root
    scratch = root / "extracted" / "_duckdb_tmp"
    scratch.mkdir(parents=True, exist_ok=True)
    loose = root / "companies_export.csv"
    loose.write_text("cnpj\n")

    report = svc.run()

    assert scratch.exists()
    assert loose.exists()
    assert report.removed_extracted == []
