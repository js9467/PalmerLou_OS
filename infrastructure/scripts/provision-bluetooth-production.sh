#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
CONFIG_SCRIPT="$REPO_ROOT/infrastructure/scripts/configure-bluetooth.sh"
ENV_FILE="/etc/palmer-lou/backend.env"

usage() {
  cat <<'USAGE'
Usage:
  provision-bluetooth-production.sh
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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

if [[ ! -x "$CONFIG_SCRIPT" ]]; then
  echo "Config script missing or not executable: $CONFIG_SCRIPT" >&2
  exit 1
fi

sudo "$CONFIG_SCRIPT" --output "$ENV_FILE"

sudo chmod +x "$REPO_ROOT"/infrastructure/scripts/bt-*.sh
sudo systemctl daemon-reload
sudo systemctl restart palmer-lou-backend

echo "Bluetooth provisioning complete. Running verification..."
echo ""

curl -s http://127.0.0.1:8787/api/bluetooth || true
echo ""
curl -s -X POST http://127.0.0.1:8787/api/bluetooth/diagnostics || true
echo ""

echo "If ready is false, review /etc/palmer-lou/backend.env and run:"
echo "  sudo systemctl status palmer-lou-backend"
