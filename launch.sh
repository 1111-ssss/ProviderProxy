#!/bin/sh
# KRunner entry point: start provider_proxy, open its GUI, exit.
# The server shuts itself down once the GUI tab is closed (see README).
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="$(node -e 'try{const dbPath=process.env.PP_DB_FILE??process.argv[1]+"/config.db",legacy=process.argv[1]+"/config.json";const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(dbPath);const row=db.prepare("SELECT value FROM settings WHERE key = '\''config'\''").get();console.log(row?.value?JSON.parse(row.value).port??8787:require(legacy).port??8787);db.close()}catch{try{console.log(require(process.argv[1]+"/config.json").port??8787)}catch{console.log(8787)}}' "$DIR")"
# Keep the pathname stable for older already-running proxy processes. Current
# server.mjs sends Cache-Control: no-store for the GUI, so a query is not needed.
URL="http://127.0.0.1:$PORT/"

HEALTH="$(curl -sf "$URL/api/ping" 2>/dev/null || true)"
STALE=0
case "$HEALTH" in
  *'"apiVersion":3'*) ;;
  *)
    # A previous proxy process may still be serving the old backend after an update.
    # Release this app's port so the freshly started server gets the new routes.
    if command -v fuser >/dev/null 2>&1; then
      fuser -k "$PORT/tcp" >/dev/null 2>&1 || true
    elif command -v lsof >/dev/null 2>&1; then
      lsof -ti "TCP:$PORT" -sTCP:LISTEN | xargs -r kill >/dev/null 2>&1 || true
    else
      pkill -f "[n]ode .*${DIR}/server.mjs" >/dev/null 2>&1 || true
    fi
    STALE=1
    ;;
esac

if [ "$STALE" -eq 1 ] || ! curl -sf -o /dev/null "$URL"; then
  nohup node "$DIR/server.mjs" >> "$DIR/server.log" 2>&1 &
  i=0
  while [ $i -lt 50 ] && ! curl -sf -o /dev/null "$URL"; do
    sleep 0.1
    i=$((i + 1))
  done
fi

xdg-open "$URL"
