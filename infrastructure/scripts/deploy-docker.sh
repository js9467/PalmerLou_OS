#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
MODE="dev"

usage() {
  cat <<'USAGE'
Usage:
  deploy-docker.sh [--mode dev|linux-bt]

Modes:
  dev      Quick local test, Bluetooth readiness not required.
  linux-bt Linux Bluetooth integration with strict readiness enabled.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="${2:-}"
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

cd "$REPO_ROOT"

if [[ ! -f infrastructure/docker/backend.env ]]; then
  cp infrastructure/docker/backend.env.example infrastructure/docker/backend.env
  echo "Created infrastructure/docker/backend.env from template"
fi

if [[ "$MODE" == "dev" ]]; then
  sed -i 's/^PALMER_LOU_REQUIRE_BLUETOOTH_READY=.*/PALMER_LOU_REQUIRE_BLUETOOTH_READY=false/' infrastructure/docker/backend.env
  docker compose up --build -d palmer-lou
elif [[ "$MODE" == "linux-bt" ]]; then
  sed -i 's/^PALMER_LOU_REQUIRE_BLUETOOTH_READY=.*/PALMER_LOU_REQUIRE_BLUETOOTH_READY=true/' infrastructure/docker/backend.env
  docker compose --profile linux-bt up --build -d palmer-lou-linux-bluetooth
else
  echo "Invalid mode: $MODE" >&2
  usage
  exit 1
fi

echo "Deployment complete."
echo "Health:"
curl -s http://127.0.0.1:8787/api/health || true
echo ""
echo "Bluetooth:"
curl -s http://127.0.0.1:8787/api/bluetooth || true
echo ""
