#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
image="cqu-browser-tests:$(git rev-parse --short HEAD)"
network_args=()
# Match Wrangler's Cloudflare CI container build behavior. Workers Builds can
# set this variable to make container commands use the host network for egress.
if [[ -n "${WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST:-}" ]]; then
  network_args+=(--network host)
fi
docker build --platform linux/amd64 "${network_args[@]}" -t "$image" ./container
docker build --platform linux/amd64 "${network_args[@]}" \
  --build-arg BASE="$image" -t "$image" -f container/Dockerfile.test .
