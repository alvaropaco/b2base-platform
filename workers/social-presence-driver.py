#!/usr/bin/env python3
# =============================================================================
# workers/social-presence-driver.py — ponte entre o worker Node
# (workers/social-presence.js) e a biblioteca maigret (MIT).
#
# Contrato: recebe usernames no argv; imprime NO STDOUT uma linha JSON por
# perfil encontrado e uma linha final {"kind":"done", ...}. Qualquer erro de
# ambiente (maigret ausente) vira {"kind":"error","code":"MAIGRET_UNAVAILABLE"}
# na primeira linha — o worker Node traduz para FAILED não-retentável.
#
# Curadoria (2026-10-10): top 200 sites por rank do banco do maigret,
# excluindo categorias insensíveis — varredura respeitosa (~1-2 min), não as
# ~2900. Deadline geral é do worker Node (SIGKILL), que parseia o NDJSON
# parcial mesmo assim.
# =============================================================================

import asyncio
import json
import logging
import re
import sys

# Pegada calibrada para o pod do worker (limite 384Mi, junto do Node):
# 80 sites × 8 conexões estourar memória NUNCA — OOM do container derrubava
# as outras tasks do worker junto (2026-10-13, 3× OOMKilled em produção).
TOP_SITES = 80
EXCLUDED_TAGS = ["dating", "nsfw", "cannabis"]
PER_SITE_TIMEOUT = 8
MAX_CONNECTIONS = 8


def slugify(value: str) -> str:
    lowered = (value or "").strip().lower()
    normalized = re.sub(r"[^a-z0-9]+", "", lowered)
    return normalized


def candidates_from_args(args: list) -> list:
    # argv: username1 username2 ... (o worker Node já fez a curadoria)
    out = []
    for raw in args:
        slug = slugify(raw)
        if 4 <= len(slug) <= 40 and slug not in out:
            out.append(slug)
    return out[:6]


async def run(username: str, sites: dict, logger) -> None:
    from maigret import search as maigret_search

    results = await maigret_search(
        username=username,
        site_dict=sites,
        logger=logger,
        timeout=PER_SITE_TIMEOUT,
        is_parsing_enabled=False,
        no_progressbar=True,
        max_connections=MAX_CONNECTIONS,
    )
    for site_name, result in (results or {}).items():
        try:
            found = result["status"].is_found()
        except Exception:
            continue
        if not found:
            continue
        print(json.dumps({
            "kind": "found",
            "username": username,
            "site": site_name,
            "url": result.get("url_user"),
            "http_status": result.get("http_status"),
        }), flush=True)


def main() -> int:
    usernames = candidates_from_args(sys.argv[1:])
    if not usernames:
        print(json.dumps({"kind": "done", "profiles": 0}), flush=True)
        return 0

    logger = logging.getLogger("maigret-driver")
    logging.basicConfig(level=logging.CRITICAL)  # NDJSON limpo no stdout
    logger.disabled = True

    try:
        import os

        import maigret as maigret_pkg
        from maigret.sites import MaigretDatabase

        # Banco de sites mora DENTRO do pacote instalado — path relativo só
        # funcionava com CWD no repo do maigret (não é o caso no container).
        db_path = os.path.join(os.path.dirname(maigret_pkg.__file__), "resources", "data.json")
        db = MaigretDatabase().load_from_path(db_path)
        sites = db.ranked_sites_dict(top=TOP_SITES, excluded_tags=EXCLUDED_TAGS)
    except Exception as err:
        print(json.dumps({"kind": "error", "code": "MAIGRET_UNAVAILABLE", "message": str(err)[:200]}), flush=True)
        return 0

    total = 0
    try:
        for username in usernames:
            try:
                asyncio.run(run(username, sites, logger))
            except Exception as err:
                print(json.dumps({"kind": "error", "code": "SCAN_ERROR", "username": username, "message": str(err)[:200]}), flush=True)
    except KeyboardInterrupt:
        pass
    print(json.dumps({"kind": "done"}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
