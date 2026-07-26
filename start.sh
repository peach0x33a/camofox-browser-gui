#!/usr/bin/env bash
# Start the camofox-gui control panel (opens the browser automatically).
set -euo pipefail
cd "$(dirname "$0")"
exec node src/main.js "$@"
