#!/usr/bin/env bash
#
# Follow the logs.
#
#   ./logs.sh              ParaBank (docker), following
#   ./logs.sh --console    the operator console instead
#   ./logs.sh --no-follow  print what is there and exit
#   ./logs.sh -n 200       last 200 lines (default 100)
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

TARGET=docker
FOLLOW=1
LINES=100

while [ $# -gt 0 ]; do
  case "$1" in
    --console)   TARGET=console ;;
    --no-follow) FOLLOW=0 ;;
    -n)          LINES="${2:-100}"; shift ;;
    -h|--help)   sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$TARGET" = "console" ]; then
  [ -f console.log ] || { echo "  no console.log — is the console running? ./start.sh" >&2; exit 1; }
  if [ "$FOLLOW" = "1" ]; then tail -n "$LINES" -f console.log; else tail -n "$LINES" console.log; fi
  exit 0
fi

command -v docker >/dev/null || { echo "  docker is not installed." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "  the docker daemon is not running." >&2; exit 1; }

if [ "$FOLLOW" = "1" ]; then
  docker compose logs --tail "$LINES" -f
else
  docker compose logs --tail "$LINES"
fi
