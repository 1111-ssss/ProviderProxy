#!/bin/sh
# Backwards-compatible entry point; install both explicit launchers.
set -eu
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$DIR/install-shortcuts.sh" "$@"
