#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BUNDLE=0

# Prefer the rustup-managed toolchain when it is installed. This avoids picking
# an old system Cargo that cannot read the lockfile used by the desktop app.
if [ -x "${HOME:-}/.cargo/bin/cargo" ]; then
  PATH="$HOME/.cargo/bin:$PATH"
  export PATH
fi

usage() {
  cat <<'EOF'
Сборка Provider Proxy для Linux.

Использование:
  ./release.sh              собрать release-бинарник
  ./release.sh --bundle     собрать бинарник и пакеты Tauri (AppImage и другие доступные)
  ./release.sh --help       показать эту справку

Для пакетной сборки с updater-артефактами задайте TAURI_SIGNING_PRIVATE_KEY.
EOF
}

case "${1:-}" in
  "") ;;
  --bundle) BUNDLE=1 ;;
  --help|-h) usage; exit 0 ;;
  *)
    printf '%s\n' "Неизвестный параметр: $1" >&2
    usage >&2
    exit 2
    ;;
esac

if [ "$BUNDLE" -eq 1 ]; then
  "$ROOT/rust-desktop/build-linux.sh" --bundle
else
  "$ROOT/rust-desktop/build-linux.sh"
fi
