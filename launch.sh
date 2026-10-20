#!/bin/sh
# KRunner entry point: start provider_proxy, open its GUI, exit.
# The server shuts itself down once the GUI tab is closed (see README).
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="$(node -e 'try{console.log(require(process.argv[1]+"/config.json").port??8787)}catch{console.log(8787)}' "$DIR")"
# Cache-bust the GUI on every shortcut launch. The proxy also serves index.html
# with no-store, but the query protects against an already-open browser cache.
URL="http://127.0.0.1:$PORT/?v=$(date +%s)"

if ! curl -sf -o /dev/null "$URL"; then
  nohup node "$DIR/server.mjs" >> "$DIR/server.log" 2>&1 &
  i=0
  while [ $i -lt 50 ] && ! curl -sf -o /dev/null "$URL"; do
    sleep 0.1
    i=$((i + 1))
  done
fi

xdg-open "$URL"
