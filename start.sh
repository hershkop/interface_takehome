#!/usr/bin/env bash
#
# Bring the whole system up: ParaBank, seeded, plus the operator console.
#
#   ./start.sh                 ParaBank + console
#   ./start.sh --no-console    ParaBank only (what the CLI needs)
#   ./start.sh --no-seed       skip the fixture reset, keep whatever state is there
#
# A console already running is restarted, not reused: it serves the source it loaded at
# startup, so one left over from before a pull reports valid capabilities as invalid.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

WITH_CONSOLE=1
SEED=1
for arg in "$@"; do
  case "$arg" in
    --no-console) WITH_CONSOLE=0 ;;
    --no-seed)    SEED=0 ;;
    -h|--help)    sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# Always restarted, never reused.
#
# The console loads the source once, at startup, and then serves it for as long as it lives —
# so one left running across a `git pull` keeps answering with the code it started with. The
# symptom is worse than the cause: a capability using anything new is reported as *invalid*,
# with a schema error naming a vocabulary the running process has never heard of, and the
# message blames the artifact rather than the server. Restarting costs two seconds.
if [ "$WITH_CONSOLE" = "1" ]; then
  if [ -f "$CONSOLE_PID_FILE" ]; then
    old_pid="$(cat "$CONSOLE_PID_FILE")"
    if kill -0 "$old_pid" 2>/dev/null; then
      kill "$old_pid" 2>/dev/null || true
      say "stopping the console already running (pid ${old_pid})"
    fi
    rm -f "$CONSOLE_PID_FILE"
  fi

  # The pid file is not the whole story: a console started by hand, or one whose file was
  # removed, still holds the port — and the next start then fails with EADDRINUSE and a stack
  # trace in a log nobody has opened yet. Whatever holds the port goes too.
  if command -v lsof >/dev/null; then
    holders="$(lsof -ti "tcp:${CONSOLE_PORT}" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$holders" ]; then
      # shellcheck disable=SC2086
      kill $holders 2>/dev/null || true
      say "freed port ${CONSOLE_PORT}"
    fi
  else
    pkill -f "tsx src/console" 2>/dev/null && say "stopped a stray console process" || true
  fi

  # Ports do not free instantly, and starting into a half-closed socket is the same failure
  # with a more confusing message.
  for _ in $(seq 1 10); do
    if command -v lsof >/dev/null; then
      lsof -ti "tcp:${CONSOLE_PORT}" -sTCP:LISTEN >/dev/null 2>&1 || break
    else
      break
    fi
    sleep 0.3
  done

  say "starting the operator console..."
  npm run --silent console > "$CONSOLE_LOG" 2>&1 &
  echo $! > "$CONSOLE_PID_FILE"
  sleep 2
  kill -0 "$(cat "$CONSOLE_PID_FILE")" 2>/dev/null \
    || die "the console failed to start. See $CONSOLE_LOG"
fi

printf '\n'
say "ParaBank   http://localhost:${PARABANK_PORT}/parabank   (john / demo)"
[ "$WITH_CONSOLE" = "1" ] && say "Console    http://127.0.0.1:${CONSOLE_PORT}"
printf '\n'
say "logs:  ./logs.sh          stop:  ./stop.sh"
printf '\n'
