"""Retention policies (spec section 34).

Never removes: the current snapshot, the previous snapshot needed for the next
diff, snapshots used by an active backfill, or artifacts of a FAILED run.

The protection set guards *canonical snapshots* only. Raw artifacts
(``downloads``, ``extracted``, ``diffs``, ``rejected``) are pinned by nothing
more than their own retention window: once the canonical parquet for a version
exists, the extracted CSVs and source archives are pure duplication.
"""

from __future__ import annotations

import re
import shutil
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select

from cnpj_data_publisher.config import get_settings
from cnpj_data_publisher.database.models import (
    BackfillRun,
    BackfillStatus,
    SnapshotStatus,
    SourceSnapshot,
)
from cnpj_data_publisher.database.repositories import (
    OutboxRepository,
    RejectedRowRepository,
    SnapshotRepository,
)
from cnpj_data_publisher.database.session import session_scope
from cnpj_data_publisher.logging import get_logger

logger = get_logger(__name__)

VERSION_RE = re.compile(r"^\d{4}-\d{2}$")


@dataclass(slots=True)
class CleanupReport:
    protected: set[str] = field(default_factory=set)
    removed_downloads: list[str] = field(default_factory=list)
    removed_extracted: list[str] = field(default_factory=list)
    removed_snapshots: list[str] = field(default_factory=list)
    removed_diffs: list[str] = field(default_factory=list)
    removed_rejected: list[str] = field(default_factory=list)
    deleted_outbox_rows: int = 0
    deleted_rejected_rows: int = 0

    def as_dict(self) -> dict[str, object]:
        return {
            "protected": sorted(self.protected),
            "removed_downloads": self.removed_downloads,
            "removed_extracted": self.removed_extracted,
            "removed_snapshots": self.removed_snapshots,
            "removed_diffs": self.removed_diffs,
            "removed_rejected": self.removed_rejected,
            "deleted_outbox_rows": self.deleted_outbox_rows,
            "deleted_rejected_rows": self.deleted_rejected_rows,
        }


def _months_ago(months: int) -> str:
    """Snapshot version cutoff, e.g. 3 months before today -> '2026-05'."""
    now = datetime.now(UTC)
    total = now.year * 12 + (now.month - 1) - months
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


class RetentionService:
    def __init__(self, dry_run: bool = False) -> None:
        self.settings = get_settings()
        self.dry_run = dry_run

    # -- protection ---------------------------------------------------------
    def protected_versions(self) -> set[str]:
        protected: set[str] = set()
        with session_scope() as session:
            repo = SnapshotRepository(session)

            current = repo.latest_completed()
            if current:
                protected.add(current.snapshot_version)
                previous = repo.latest_completed(before_version=current.snapshot_version)
                if previous:
                    protected.add(previous.snapshot_version)

            # Any snapshot still referenced by a live backfill.
            active = session.execute(
                select(BackfillRun.snapshot_version).where(
                    BackfillRun.status.in_(
                        [BackfillStatus.PENDING, BackfillStatus.RUNNING, BackfillStatus.PAUSED]
                    )
                )
            ).scalars()
            protected.update(active)

            # Anything that failed stays for diagnosis.
            failed = session.execute(
                select(SourceSnapshot.snapshot_version).where(
                    SourceSnapshot.status == SnapshotStatus.FAILED
                )
            ).scalars()
            protected.update(failed)

        return protected

    # -- filesystem -----------------------------------------------------------
    def _sweep(self, root: Path, cutoff: str, protected: set[str]) -> list[str]:
        if not root.is_dir():
            return []

        removed: list[str] = []
        for entry in sorted(root.iterdir()):
            if not entry.is_dir() or not VERSION_RE.match(entry.name):
                continue
            if entry.name in protected or entry.name >= cutoff:
                continue
            if not self.dry_run:
                shutil.rmtree(entry, ignore_errors=True)
            removed.append(entry.name)
        return removed

    # -- run -------------------------------------------------------------------
    def run(self) -> CleanupReport:
        protected = self.protected_versions()
        report = CleanupReport(protected=protected)
        root = self.settings.data_root

        # Only the canonical snapshot tree is protected from age-based pruning.
        # Raw artifacts follow their own retention window exclusively: the
        # snapshot protection set is about diff/backfill needs, which operate on
        # canonical parquet, never on extracted CSVs or source archives.
        report.removed_downloads = self._sweep(
            root / "downloads", _months_ago(self.settings.keep_raw_downloads_months), set()
        )
        report.removed_extracted = self._sweep(
            root / "extracted", _months_ago(self.settings.keep_extracted_files_months), set()
        )
        report.removed_snapshots = self._sweep(
            root / "snapshots",
            _months_ago(self.settings.keep_canonical_snapshots_months),
            protected,
        )
        report.removed_diffs = self._sweep(
            root / "diffs", _months_ago(self.settings.keep_diffs_months), set()
        )
        report.removed_rejected = self._sweep(
            root / "rejected", _months_ago(self.settings.keep_rejected_rows_months), set()
        )

        if not self.dry_run:
            with session_scope() as session:
                report.deleted_outbox_rows = OutboxRepository(session).delete_published_older_than(
                    self.settings.keep_published_outbox_days
                )
                report.deleted_rejected_rows = RejectedRowRepository(session).delete_older_than(
                    self.settings.keep_rejected_rows_months
                )

        logger.info("cleanup_completed", dry_run=self.dry_run, **report.as_dict())
        return report
