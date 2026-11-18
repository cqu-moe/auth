#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
image="cqu-browser-tests:$(git rev-parse --short HEAD)"
# Bash 3.2 treats an empty array as unset under nounset; positional args are safe.
set --
# Match Wrangler's Cloudflare CI container build behavior. Workers Builds can
# set this variable to make container commands use the host network for egress.
if [[ -n "${WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST:-}" ]]; then
  set -- --network host
fi
docker build --platform linux/amd64 "$@" -t "$image" ./container
docker build --platform linux/amd64 "$@" \
  --build-arg BASE="$image" -t "$image" -f container/Dockerfile.test .
