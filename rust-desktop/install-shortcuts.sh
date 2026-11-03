#!/bin/sh
# Install distinct user-level launchers for the Rust and npm versions.
set -eu

DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(CDPATH= cd -- "$DIR/.." && pwd)"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

mkdir -p "$APP_DIR"
desktop_value() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/ /\\s/g; s/\t/\\t/g'
}
DESKTOP_DIR=$(desktop_value "$DIR")
DESKTOP_ROOT=$(desktop_value "$ROOT")
DESKTOP_ICON=$(desktop_value "$DIR/icons/icon.png")

cat >"$APP_DIR/provider-proxy-rust.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Provider Proxy Rust
Comment=Provider Proxy Rust desktop application
Exec="$DIR/launch.sh"
Path=$DESKTOP_DIR
Icon=$DESKTOP_ICON
Terminal=false
Categories=Development;Utility;
StartupWMClass=provider-proxy-desktop
EOF

cat >"$APP_DIR/provider-proxy-npm.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Provider Proxy npm
Comment=Provider Proxy Node.js/npm web application
Exec="$ROOT/launch.sh"
Path=$DESKTOP_ROOT
Icon=$DESKTOP_ICON
Terminal=false
Categories=Development;Utility;
StartupWMClass=provider-proxy-npm
EOF

chmod 0644 "$APP_DIR/provider-proxy-rust.desktop" "$APP_DIR/provider-proxy-npm.desktop"
chmod 0755 "$DIR/launch.sh"
rm -f \
  "$APP_DIR/provider-proxy.desktop" \
  "$APP_DIR/Provider Proxy.desktop" \
  "$APP_DIR/provider-proxy-desktop.desktop" \
  "$APP_DIR/Provider Proxy Rust.desktop"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
fi
if command -v kbuildsycoca6 >/dev/null 2>&1; then
  kbuildsycoca6 >/dev/null 2>&1 || true
elif command -v kbuildsycoca5 >/dev/null 2>&1; then
  kbuildsycoca5 >/dev/null 2>&1 || true
fi

printf '%s\n' "$APP_DIR/provider-proxy-rust.desktop"
printf '%s\n' "$APP_DIR/provider-proxy-npm.desktop"
