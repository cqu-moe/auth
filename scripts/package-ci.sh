#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test -f frontend/dist/index.html
test -f dist-worker/index.js
mkdir -p artifacts
commit="$(git rev-parse HEAD)"
# Only explicit build outputs and deployment contracts; never archive the checkout.
tar --exclude='*.map' -czf "artifacts/auth-$commit.tar.gz" \
  frontend/dist dist-worker docs/api/*.json drizzle/migrations
(cd artifacts && shasum -a 256 "auth-$commit.tar.gz" > SHA256SUMS)
