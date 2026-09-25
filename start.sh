#!/usr/bin/env bash
#
# Bring the whole system up: ParaBank, seeded, plus the operator console.
#
#   ./start.sh                 ParaBank + console
#   ./start.sh --no-console    ParaBank only (what the CLI needs)
#   ./start.sh --no-seed       skip the fixture reset, keep whatever state is there
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

WITH_CONSOLE=1
SEED=1
for arg in "$@"; do
  case "$arg" in
    --no-console) WITH_CONSOLE=0 ;;
    --no-seed)    SEED=0 ;;
    -h|--help)    sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

PARABANK_PORT="${PARABANK_PORT:-18080}"
CONSOLE_PORT="${CONSOLE_PORT:-17080}"
CONSOLE_PID_FILE=".console.pid"
CONSOLE_LOG="console.log"

say() { printf '  %s\n' "$*"; }
die() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker is not installed."
docker info >/dev/null 2>&1 || die "the docker daemon is not running."
[ -d node_modules ] || die "dependencies are missing. Run: npm install && npm run install:browsers"

printf '\n'

# ── ParaBank ──────────────────────────────────────────────────────────────────
say "starting ParaBank on port ${PARABANK_PORT}..."
docker compose up -d >/dev/null 2>&1

printf '  waiting for it to become healthy'
for _ in $(seq 1 45); do
  status="$(docker inspect --format '{{.State.Health.Status}}' parabank 2>/dev/null || echo starting)"
  [ "$status" = "healthy" ] && break
  printf '.'
  sleep 2
done
printf '\n'
[ "${status:-}" = "healthy" ] || die "ParaBank did not become healthy. Try: ./logs.sh"
say "ParaBank is healthy"

# ── Fixture state ─────────────────────────────────────────────────────────────
# Seeded every start so account IDs and balances are the same every time. Transfers
# performed by demo runs move real money in the container, so state drifts without this.
if [ "$SEED" = "1" ]; then
  say "seeding fixture data..."
  npm run --silent setup >/dev/null || die "seeding failed. Try: npm run setup"
  say "seeded — accounts 12345, 12678 (SAVINGS), 99999 is absent"
fi

# ── Console ───────────────────────────────────────────────────────────────────
if [ "$WITH_CONSOLE" = "1" ] && [ ! -f src/console/index.ts ]; then
  say "no operator console in this checkout — starting ParaBank only"
  WITH_CONSOLE=0
fi

if [ "$WITH_CONSOLE" = "1" ]; then
  if [ -f "$CONSOLE_PID_FILE" ] && kill -0 "$(cat "$CONSOLE_PID_FILE")" 2>/dev/null; then
    say "console already running (pid $(cat "$CONSOLE_PID_FILE"))"
  else
    say "starting the operator console..."
    npm run --silent console > "$CONSOLE_LOG" 2>&1 &
    echo $! > "$CONSOLE_PID_FILE"
    sleep 2
    kill -0 "$(cat "$CONSOLE_PID_FILE")" 2>/dev/null \
      || die "the console failed to start. See $CONSOLE_LOG"
  fi
fi

printf '\n'
say "ParaBank   http://localhost:${PARABANK_PORT}/parabank   (john / demo)"
[ "$WITH_CONSOLE" = "1" ] && say "Console    http://127.0.0.1:${CONSOLE_PORT}"
printf '\n'
say "logs:  ./logs.sh          stop:  ./stop.sh"
printf '\n'
