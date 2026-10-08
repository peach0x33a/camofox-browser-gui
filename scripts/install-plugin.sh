#!/usr/bin/env bash
# Compatibility entry point; installation itself is platform independent.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$HERE/scripts/install-plugin.mjs" "$@"
