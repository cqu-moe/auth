#!/bin/sh
set -eu
exec /opt/chrome/chrome-linux64/chrome --ignore-certificate-errors-spki-list="$(cat /fixture/spki)" "$@"
