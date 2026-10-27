#!/bin/sh
# Desktop-entry launcher for the Rust/Tauri build.
# Keep the project config as the default, but allow PP_CONFIG_FILE for tests and alternate setups.
set -u

DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(CDPATH= cd -- "$DIR/.." && pwd)"
CONFIG="${PP_CONFIG_FILE:-$ROOT/config.json}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/provider-proxy"
LOG="$STATE_DIR/rust-desktop.log"
BINARY="$DIR/target/release/provider-proxy-desktop"
BUILD_LOG="$STATE_DIR/rust-desktop-build.log"
LOCK_DIR="$STATE_DIR/rust-desktop-build.lock"
if [ -n "${CARGO_BIN:-}" ]; then
  CARGO_BIN="$CARGO_BIN"
elif [ -x "$HOME/.cargo/bin/cargo" ]; then
  CARGO_BIN="$HOME/.cargo/bin/cargo"
elif [ -x "/root/.cargo/bin/cargo" ]; then
  CARGO_BIN="/root/.cargo/bin/cargo"
else
  CARGO_BIN="$(command -v cargo || true)"
fi

mkdir -p "$STATE_DIR"
export PP_CONFIG_FILE="$CONFIG"
export PP_CONFIG_KEY_FILE="${PP_CONFIG_KEY_FILE:-$HOME/.config/provider-proxy/master.key}"

APPIMAGE=""
pick_appimage() {
  # Tauri names the current bundle from `productName`. Older builds used
  # "Provider Proxy", while the current desktop app is "Provider Proxy Rust".
  # Prefer the current name so a stale old AppImage cannot be launched (or
  # selected forever by source_is_newer); keep the old pattern as a fallback
  # for installations that have not been rebuilt yet.
  for candidate in \
    "$DIR"/target/release/bundle/appimage/Provider\ Proxy\ Rust_*.AppImage \
    "$DIR"/target/release/bundle/appimage/Provider\ Proxy_*.AppImage; do
    if [ -x "$candidate" ]; then
      APPIMAGE="$candidate"
      return
    fi
  done
}
pick_appimage

# Launch the freshest artifact. The AppImage is just packaging: the frontend is
# embedded in the binary, so a plain `cargo build --release` is enough to run.
pick_artifact() {
  if [ -n "$APPIMAGE" ] && [ -x "$APPIMAGE" ] && { [ ! -x "$BINARY" ] || [ "$APPIMAGE" -nt "$BINARY" ]; }; then
    ARTIFACT="$APPIMAGE"
  else
    ARTIFACT="$BINARY"
  fi
}
ARTIFACT=""
pick_artifact

source_is_newer() {
  [ -n "$ARTIFACT" ] || return 0
  for path in "$DIR/src" "$DIR/frontend" "$DIR/icons" "$DIR/Cargo.toml" "$DIR/Cargo.lock" "$DIR/build.rs" "$DIR/tauri.conf.json"; do
    if [ -d "$path" ]; then
      if find "$path" -type f -newer "$ARTIFACT" -print -quit | grep -q .; then return 0; fi
    elif [ -f "$path" ] && [ "$path" -nt "$ARTIFACT" ]; then
      return 0
    fi
  done
  return 1
}

# The old browser shortcut starts the Node backend from this same project. It
# owns the configured port, so replace only that exact process when switching
# to the Rust desktop build; unrelated Node processes are left untouched.
if command -v ps >/dev/null 2>&1; then
  ps -eo pid=,args= | while read -r pid command rest; do
    [ "$command" = "node" ] || continue
    set -- $rest
    [ "${1:-}" = "$ROOT/server.mjs" ] || continue
    kill "$pid" >/dev/null 2>&1 || true
    printf '%s\n' "stopped old Node backend (pid $pid)" >>"$LOG"
  done
  sleep 0.2
fi

run_failed() {
  status="${1:-1}"
  if command -v notify-send >/dev/null 2>&1; then
    notify-send "Provider Proxy" "Rust-версия не запустилась. Подробности: $LOG" >/dev/null 2>&1 || true
  fi
  exit "$status"
}

# A shortcut may keep pointing at this script for months. Rebuild before
# launching when any Rust/Tauri source is newer than the packaged artifact.
# This checks the AppImage (the preferred launch target), not only the raw
# binary, because the AppImage also contains the current frontend.
NEEDS_BUILD=0
if [ ! -x "$ARTIFACT" ]; then
  NEEDS_BUILD=1
elif source_is_newer; then
  NEEDS_BUILD=1
fi

if [ "$NEEDS_BUILD" -eq 1 ]; then
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    sleep 0.2
  done
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM

  # Another shortcut invocation may have finished the build while we waited.
  pick_artifact
  if [ ! -x "$ARTIFACT" ] || source_is_newer; then
    printf '%s\n' "Rust build required; compiling latest sources" >>"$LOG"
    if [ -z "$CARGO_BIN" ]; then
      printf '%s\n' "cargo not found; cannot rebuild Rust desktop app" >>"$LOG"
      run_failed 1
    fi
    if ! (cd "$DIR" && "$CARGO_BIN" tauri build -- --locked) >>"$BUILD_LOG" 2>&1; then
      # Bundling (AppImage/deb) needs libappindicator detection, which is not
      # always installed. The binary itself is the app, so build that instead.
      printf '%s\n' "AppImage bundling failed; falling back to cargo build" >>"$LOG"
      if ! (cd "$DIR" && "$CARGO_BIN" build --release --locked) >>"$BUILD_LOG" 2>&1; then
        printf '%s\n' "Rust build failed; see $BUILD_LOG" >>"$LOG"
        run_failed 1
      fi
    fi
    pick_artifact
    if [ ! -x "$ARTIFACT" ]; then
      printf '%s\n' "Rust build completed but no binary was found" >>"$LOG"
      run_failed 1
    fi
    printf '%s\n' "Rust build completed" >>"$LOG"
  fi
  rmdir "$LOCK_DIR" 2>/dev/null || true
  trap - EXIT INT TERM
fi

start_desktop() {
  command="$1"
  nohup "$command" >>"$LOG" 2>&1 &
  pid=$!
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    printf '%s\n' "Rust desktop started (pid $pid)" >>"$LOG"
    return 0
  fi
  printf '%s\n' "Rust desktop exited during startup (pid $pid); see $LOG" >>"$LOG"
  return 1
}

if [ -n "$ARTIFACT" ] && [ -x "$ARTIFACT" ]; then
  start_desktop "$ARTIFACT" || run_failed 1
else
  printf '%s\n' "Rust build not found after compilation: $BINARY" >>"$LOG"
  run_failed 1
fi
