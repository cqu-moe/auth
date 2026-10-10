#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test -f frontend/dist/index.html
test -f dist-worker/index.js
mkdir -p artifacts
commit="$(git rev-parse HEAD)"
SOURCE_COMMIT="$commit" node -e 'require("node:fs").writeFileSync("artifacts/build-info.json", JSON.stringify({sourceCommit: process.env.SOURCE_COMMIT, version: require("./package.json").version}, null, 2) + "\n")'
# Only explicit build outputs and deployment contracts; never archive the checkout.
tar --exclude='*.map' --exclude='dist-worker/README.md' -czf "artifacts/auth-$commit.tar.gz" \
  frontend/dist dist-worker docs/api/*.json drizzle/migrations -C artifacts build-info.json
(cd artifacts && shasum -a 256 "auth-$commit.tar.gz" build-info.json > SHA256SUMS)
