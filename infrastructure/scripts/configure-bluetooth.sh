#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE_FILE="$REPO_ROOT/infrastructure/systemd/palmer-lou-backend.env.example"
TARGET_FILE="/etc/palmer-lou/backend.env"

usage() {
  cat <<'USAGE'
Usage:
  configure-bluetooth.sh [--output /etc/palmer-lou/backend.env]
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      TARGET_FILE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ ! -f "$TEMPLATE_FILE" ]]; then
  echo "Template not found: $TEMPLATE_FILE" >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET_FILE")"
cp "$TEMPLATE_FILE" "$TARGET_FILE"

echo "Wrote $TARGET_FILE"
echo "Next steps:"
echo "  1) Review and adjust runtime settings in $TARGET_FILE"
echo "  2) sudo systemctl daemon-reload"
echo "  3) sudo systemctl restart palmer-lou-backend"
echo "  4) curl -s http://127.0.0.1:8787/api/bluetooth"
