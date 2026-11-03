#!/bin/sh
set -eu

DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$DIR"

if [ "${1:-}" = "--bundle" ]; then
  cargo tauri build --ci -- --locked
else
  cargo build --release --locked
fi

printf '%s\n' "Бинарник: $DIR/target/release/provider-proxy-desktop"
if [ -d "$DIR/target/release/bundle" ]; then
  printf '%s\n' "Пакеты: $DIR/target/release/bundle"
fi
