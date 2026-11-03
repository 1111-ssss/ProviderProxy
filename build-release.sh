#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUST_DIR="$ROOT/rust-desktop"
WINDOWS_TARGET="x86_64-pc-windows-gnu"

if [ -x "${HOME:-}/.cargo/bin/cargo" ]; then
  PATH="$HOME/.cargo/bin:$PATH"
  export PATH
fi

usage() {
  cat <<'EOF'
Собирает неподписанные release-бинарники Provider Proxy для Linux и Windows,
упаковывает их в ZIP и кладёт в системную папку «Загрузки».

Использование:
  ./build-release.sh
  ./build-release.sh --help

Для Windows-кросс-сборки нужны rustup, target x86_64-pc-windows-gnu,
MinGW (x86_64-w64-mingw32-gcc), а при отсутствии icons/icon.ico — ImageMagick.

Для другого каталога вывода задайте PP_RELEASE_OUTPUT_DIR.
EOF
}

case "${1:-}" in
  "") ;;
  --help|-h) usage; exit 0 ;;
  *)
    printf '%s\n' "Неизвестный параметр: $1" >&2
    usage >&2
    exit 2
    ;;
esac

command -v cargo >/dev/null 2>&1 || {
  printf '%s\n' "Не найден cargo. Установите Rust через rustup." >&2
  exit 1
}
command -v rustup >/dev/null 2>&1 || {
  printf '%s\n' "Не найден rustup. Он нужен для Windows target." >&2
  exit 1
}
command -v zip >/dev/null 2>&1 || {
  printf '%s\n' "Не найден zip. Установите пакет zip." >&2
  exit 1
}
MINGW_GCC=$(command -v x86_64-w64-mingw32-gcc || true)
if [ -z "$MINGW_GCC" ]; then
  printf '%s\n' "Не найден x86_64-w64-mingw32-gcc (MinGW)." >&2
  exit 1
fi

VERSION=$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$RUST_DIR/Cargo.toml" | head -n 1)
if [ -z "$VERSION" ]; then
  printf '%s\n' "Не удалось определить версию из rust-desktop/Cargo.toml." >&2
  exit 1
fi

if [ -n "${PP_RELEASE_OUTPUT_DIR:-}" ]; then
  DOWNLOADS=$PP_RELEASE_OUTPUT_DIR
elif command -v xdg-user-dir >/dev/null 2>&1; then
  DOWNLOADS=$(xdg-user-dir DOWNLOAD)
else
  DOWNLOADS="${HOME}/Downloads"
fi
[ -n "$DOWNLOADS" ] || DOWNLOADS="${HOME}/Downloads"
mkdir -p "$DOWNLOADS"

LINUX_BINARY="$RUST_DIR/target/release/provider-proxy-desktop"
WINDOWS_BINARY="$RUST_DIR/target/$WINDOWS_TARGET/release/provider-proxy-desktop.exe"
LINUX_ZIP="$DOWNLOADS/Provider-Proxy-v${VERSION}-linux-x64.zip"
WINDOWS_ZIP="$DOWNLOADS/Provider-Proxy-v${VERSION}-windows-x64.zip"

ICON="$RUST_DIR/icons/icon.ico"
ICON_CREATED=0
WINDOWS_SCHEMA="$RUST_DIR/gen/schemas/windows-schema.json"
WINDOWS_SCHEMA_CREATED=0
TMP_DIR=$(mktemp -d)

cleanup() {
  if [ "$ICON_CREATED" -eq 1 ]; then
    rm -f "$ICON"
  fi
  if [ "$WINDOWS_SCHEMA_CREATED" -eq 1 ]; then
    rm -f "$WINDOWS_SCHEMA"
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT HUP INT TERM

if [ ! -f "$ICON" ]; then
  PNG="$RUST_DIR/icons/icon.png"
  if [ ! -f "$PNG" ]; then
    printf '%s\n' "Не найден ни icons/icon.ico, ни icons/icon.png." >&2
    exit 1
  fi
  if command -v magick >/dev/null 2>&1; then
    magick "$PNG" -define icon:auto-resize=256,128,64,48,32,16 "$ICON"
  elif command -v convert >/dev/null 2>&1; then
    convert "$PNG" -define icon:auto-resize=256,128,64,48,32,16 "$ICON"
  else
    printf '%s\n' "Не найден ImageMagick (magick/convert) для создания Windows icon.ico." >&2
    exit 1
  fi
  ICON_CREATED=1
fi

if [ ! -e "$WINDOWS_SCHEMA" ]; then
  WINDOWS_SCHEMA_CREATED=1
fi

printf 'Сборка Linux (%s)...\n' "$VERSION"
(cd "$RUST_DIR" && cargo build --release --locked)

printf 'Проверка Windows target...\n'
if ! rustup target list --installed | grep -qx "$WINDOWS_TARGET"; then
  rustup target add "$WINDOWS_TARGET"
fi

printf 'Сборка Windows (%s)...\n' "$VERSION"
(cd "$RUST_DIR" && \
  CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER="$MINGW_GCC" \
  cargo build --release --locked --target "$WINDOWS_TARGET")

[ -f "$LINUX_BINARY" ] || { printf '%s\n' "Linux-бинарник не найден." >&2; exit 1; }
[ -f "$WINDOWS_BINARY" ] || { printf '%s\n' "Windows-бинарник не найден." >&2; exit 1; }

rm -f "$LINUX_ZIP" "$WINDOWS_ZIP"
zip -q -j "$LINUX_ZIP" "$LINUX_BINARY"
zip -q -j "$WINDOWS_ZIP" "$WINDOWS_BINARY"

printf '\nГотово:\n'
printf '  %s\n' "$LINUX_ZIP"
printf '  %s\n' "$WINDOWS_ZIP"
printf '\nSHA-256:\n'
sha256sum "$LINUX_ZIP" "$WINDOWS_ZIP"
