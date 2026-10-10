#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
image="cqu-browser-tests:$(git rev-parse --short HEAD)"
docker build --platform linux/amd64 -t "$image" ./container
docker run --rm --platform linux/amd64 -v "$PWD:/workspace:ro" "$image" \
  sh -c 'python -m pip install --disable-pip-version-check pytest==9.1.1 pytest-asyncio==1.4.0 && PYTHONPATH=/app python -m pytest -q -o cache_dir=/tmp/pytest-cache /workspace/container'
