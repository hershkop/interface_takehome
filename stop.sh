#!/usr/bin/env bash
#
# Take everything down.
#
#   ./stop.sh            stop the console and ParaBank
#   ./stop.sh --clean    also delete ParaBank's volumes (a full fixture reset)
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --clean)   CLEAN=1 ;;
    -h|--help) sed -n '3,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

CONSOLE_PID_FILE=".console.pid"
say() { printf '  %s\n' "$*"; }

printf '\n'

# ── Console ───────────────────────────────────────────────────────────────────
if [ -f "$CONSOLE_PID_FILE" ]; then
  pid="$(cat "$CONSOLE_PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    say "stopped the console (pid $pid)"
  fi
  rm -f "$CONSOLE_PID_FILE"
fi
pkill -f "tsx src/console" 2>/dev/null && say "stopped a stray console process" || true

# ── Browsers ──────────────────────────────────────────────────────────────────
# An interrupted run or test worker leaves headless Chromium behind, and a leftover vitest
# worker will respawn browsers as fast as you kill them — so the worker goes first.
pkill -f "vitest" 2>/dev/null && say "stopped a leftover test worker" || true
sleep 1
# pgrep exits 1 when it matches nothing. Under `pipefail` that fails the assignment and
# `set -e` kills the script silently, before it has stopped anything — so the failure is
# absorbed at its source rather than after the pipe, which would append a second count.
browsers="$({ pgrep -f "ms-playwright/chromium" 2>/dev/null || true; } | wc -l | tr -d ' ')"
if [ "${browsers:-0}" -gt 0 ]; then
  pkill -f "ms-playwright/chromium" 2>/dev/null || true
  say "stopped ${browsers} leftover browser process(es)"
fi

# ── ParaBank ──────────────────────────────────────────────────────────────────
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  if [ "$CLEAN" = "1" ]; then
    docker compose down -v >/dev/null 2>&1 || true
    say "stopped ParaBank and removed its volumes"
  else
    docker compose down >/dev/null 2>&1 || true
    say "stopped ParaBank"
  fi
else
  say "docker is not running — nothing to stop there"
fi

printf '\n  everything is down. Start again with ./start.sh\n\n'
