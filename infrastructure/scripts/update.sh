#!/usr/bin/env bash
set -euo pipefail

repo_dir="${PALMER_LOU_REPO_DIR:-/opt/palmer-lou}"

if [ ! -d "$repo_dir/.git" ]; then
  echo "Repo not found: $repo_dir"
  exit 1
fi

cd "$repo_dir"

echo "Fetching latest changes..."
git fetch --all --tags
git pull --ff-only

echo "Installing dependencies..."
npm install

echo "Building Palmer Lou OS..."
npm run build

echo "Update complete. Restart the backend service or Docker stack to activate the new version."
