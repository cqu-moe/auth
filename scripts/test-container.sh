#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
image="cqu-browser-tests:$(git rev-parse --short HEAD)"
build_args=(build --platform linux/amd64)
# Match Wrangler's Cloudflare CI container build behavior. Workers Builds can
# set this variable to make container commands use the host network for egress.
if [[ -n "${WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST:-}" ]]; then
  build_args+=(--network host)
fi
build_args+=(-t "$image" ./container)
docker "${build_args[@]}"
run_args=(run --rm --platform linux/amd64)
if [[ -n "${WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST:-}" ]]; then
  run_args+=(--network host)
fi
run_args+=(-v "$PWD:/workspace:ro" "$image")
docker "${run_args[@]}" \
  sh -c 'python -m pip install --disable-pip-version-check pytest==9.1.1 pytest-asyncio==1.4.0 && PYTHONPATH=/app python -m pytest -q -o cache_dir=/tmp/pytest-cache /workspace/container'
