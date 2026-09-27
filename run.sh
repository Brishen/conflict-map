#!/usr/bin/env bash
# Home pipeline + local viewer. Pushes the database to the public viewer after every refresh.
cd "$(dirname "$0")"
# optional secrets (e.g. CLOUDFLARE_RADAR_TOKEN for cyber mode) in ./.env, not in git
if [ -f .env ]; then set -a; . ./.env; set +a; fi
export PUSH_TARGET="${PUSH_TARGET-luma:/root/conflict-map/data}"
exec uv run uvicorn app.server:app --host 127.0.0.1 --port "${PORT:-8765}"
