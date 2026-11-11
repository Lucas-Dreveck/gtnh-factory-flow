#!/usr/bin/env bash
# Builds the Linux bundle in Docker, adds the mirrored dataset, and writes
# dist/gtnh-planner.tar.gz to run on any host with Node 24 (node server.js).
# Usage: tools/release/package.sh [path-to-data-dir]   (default: <repo>/public, filled by tools/mirror-dataset.mjs)
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
data="${1:-$repo/public}"
out="$repo/dist"
stage="$out/gtnh-planner"
[ -f "$data/datasets/gtnh/datasets.manifest.json" ] || { echo "no dataset at $data/datasets/gtnh" >&2; exit 1; }
rm -rf "$stage" && mkdir -p "$stage"
docker build -f "$repo/deploy/Dockerfile.selfhost" --target bundle --output "type=local,dest=$stage" "$repo"
mkdir -p "$stage/public/datasets"
cp -r "$data/datasets/gtnh" "$stage/public/datasets/gtnh"
rm -f "$stage/public/datasets/gtnh/datasets.manifest.upstream.json"
git -C "$repo" rev-parse --short HEAD > "$stage/BUILD_COMMIT" 2>/dev/null || true
tar -C "$out" -czf "$out/gtnh-planner.tar.gz" gtnh-planner
echo "wrote $out/gtnh-planner.tar.gz ($(du -h "$out/gtnh-planner.tar.gz" | cut -f1))"
