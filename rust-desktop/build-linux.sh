#!/bin/sh
set -eu

DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$DIR"

if [ "${1:-}" = "--bundle" ]; then
  : "${TAURI_SIGNING_PRIVATE_KEY:?Для bundle задайте TAURI_SIGNING_PRIVATE_KEY}"
  cargo tauri build --ci -- --locked
else
  cargo build --release --locked
fi

printf '%s\n' "Бинарник: $DIR/target/release/provider-proxy-desktop"
if [ -d "$DIR/target/release/bundle" ]; then
  printf '%s\n' "Пакеты: $DIR/target/release/bundle"
fi
