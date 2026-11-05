#!/usr/bin/env bash
# Local dev instance: a throwaway DSH profile with this plugin linked, so the
# host half can be exercised (and its real errors read) without touching the
# desktop app.
#
#   scripts/dev-env.sh start          boot and print the tokenised URL
#   scripts/dev-env.sh rpc <method> [json-args]
#   scripts/dev-env.sh stop
#   scripts/dev-env.sh log            tail the instance log
#
# The profile lives in ~/.dsh/profiles/feishu-dev and stores its own state, so
# this never interferes with the desktop profile.
set -euo pipefail

PROFILE=${DSH_DEV_PROFILE:-feishu-dev}
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
PORT=${DSH_DEV_PORT:-4601}
STATE="$PROFILE_DIR/.dev-instance"
PLUGIN_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

rpc() {
  local method=$1
  local args=${2:-'{}'}
  local token cookies
  token=$(cat "$STATE/token" 2>/dev/null || true)
  cookies="$STATE/cookies"
  [ -n "$token" ] || { echo "instance is not running (start it first)" >&2; exit 1; }
  [ -f "$cookies" ] || curl -s -c "$cookies" -o /dev/null "http://127.0.0.1:$PORT/?token=$token"
  curl -s -b "$cookies" -X POST -H 'Content-Type: application/json' \
    -d "{\"type\":\"client-request\",\"rpcId\":\"dev\",\"method\":\"feishu/$method\",\"payload\":{\"args\":$args}}" \
    "http://127.0.0.1:$PORT/api/feishu/$method"
}

case "${1:-start}" in
  start)
    # Already healthy? Reuse it — restarting while another call is in flight was
    # how a token got pulled out from under a running rpc.
    if [ -f "$STATE/token" ] && [ -f "$STATE/cookies" ] \
      && curl -s -o /dev/null --max-time 2 -b "$STATE/cookies" "http://127.0.0.1:$PORT/" 2>/dev/null; then
      echo "instance already running: http://127.0.0.1:$PORT/?token=$(cat "$STATE/token")"
      exit 0
    fi
    mkdir -p "$PROFILE_DIR"
    if [ ! -f "$PROFILE_DIR/package.json" ]; then
      echo "creating profile $PROFILE from the web template…"
      dsh --profile "$PROFILE" --from-default-profile web >/dev/null 2>&1 || true
    fi
    (cd "$PROFILE_DIR" && npm_config_cache="$PROFILE_DIR/.npm-cache" pnpm add "link:$PLUGIN_DIR" >/dev/null 2>&1) || true
    node -e '
      const fs = require("fs");
      const file = process.env.HOME + "/.dsh/profiles/" + process.argv[1] + "/package.json";
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      const bundles = (pkg.dsh ??= {}).profile ??= {};
      bundles.bundles ??= ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
      if (!bundles.bundles.includes("dsh-feishu-contact")) bundles.bundles.push("dsh-feishu-contact");
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    ' "$PROFILE"

    # Isolate the instance from the desktop profile's live state: its own token,
    # state and settings files, so experiments here can never corrupt real data.
    mkdir -p "$PROFILE_DIR/feishu"
    cat > "$PROFILE_DIR/cordis.patch.yml" <<YAML
# written by scripts/dev-env.sh — dev instance keeps its own state files
- id: feishu-contact
  config:
    stateFile: "$PROFILE_DIR/feishu/state.json"
    tokenFile: "$PROFILE_DIR/feishu/user-token.json"
YAML

    mkdir -p "$STATE"
    pkill -f "profile $PROFILE" 2>/dev/null || true
    sleep 1
    ( cd "$PROFILE_DIR" && setsid nohup dsh --profile "$PROFILE" --port "$PORT" --no-open \
        < /dev/null > "$STATE/instance.log" 2>&1 & )

    for _ in $(seq 1 40); do
      if grep -q "token=" "$STATE/instance.log" 2>/dev/null; then break; fi
      sleep 0.5
    done
    url=$(grep -o "http://127.0.0.1:$PORT/?token=[A-Za-z0-9_-]*" "$STATE/instance.log" | tail -1 || true)
    if [ -z "$url" ]; then
      echo "instance did not come up; log:" >&2
      tail -20 "$STATE/instance.log" >&2
      exit 1
    fi
    echo "$url" | sed 's/.*token=//' > "$STATE/token"
    rm -f "$STATE/cookies"
    echo "instance up: $url"
    ;;
  rpc)
    shift
    rpc "$@"
    echo
    ;;
  log)
    tail -${2:-40} "$STATE/instance.log"
    ;;
  stop)
    pkill -f "profile $PROFILE" 2>/dev/null || true
    rm -f "$STATE/token" "$STATE/cookies"
    echo "stopped"
    ;;
  *)
    echo "usage: $0 {start|rpc <method> [json]|log|stop}" >&2
    exit 2
    ;;
esac
