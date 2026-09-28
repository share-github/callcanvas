#!/usr/bin/env bash
# Verify that :CallCanvas puts the viewer URL straight into the clipboard of the
# machine running the terminal (OSC 52), so nothing has to be copied by hand.
#
# Runs Neovim under a pty (`script`) and decodes the OSC 52 payload it emits.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/callcanvas-nvim"
TARGET_FILE="${1:-$REPO_ROOT/sample-app/src/main/java/com/example/demo/service/TodoService.java}"
TARGET_LINE="${2:-34}"
WORK="$(mktemp -d)"
PASS=0
FAIL=0

ok()  { printf '  PASS %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }

cleanup() {
    node "$PLUGIN_DIR/src/cli.js" stop --file "$TARGET_FILE" >/dev/null 2>&1
    rm -rf "$WORK"
}
trap cleanup EXIT

# Make sure no host from an earlier run is still holding the project's session
# (starting a second host for the same project is refused on purpose).
stop_existing_host() {
    node "$PLUGIN_DIR/src/cli.js" stop --file "$TARGET_FILE" >/dev/null 2>&1
    for _ in $(seq 1 30); do
        if node "$PLUGIN_DIR/src/cli.js" status --file "$TARGET_FILE" --json 2>/dev/null | grep -q '"running":false'; then
            return 0
        fi
        sleep 0.5
    done
    echo "  WARN: a host is still running for this project"
}

stop_existing_host

if ! command -v script >/dev/null; then
    echo "SKIP: util-linux 'script' is required to emulate a terminal"
    exit 0
fi

printf '\n=== :CallCanvas under a pty — the URL must reach the clipboard\n'

# Quit as soon as the URL has arrived (vim.wait keeps pumping the event loop, so
# the vim.system callback still runs) instead of guessing a fixed delay — the
# analysis time depends on the project's configured depth.
# depth=1 keeps this test about the clipboard, not about analysis size.
TERM=xterm-256color timeout 300 script -q -c "nvim -u NONE \
  --cmd 'set rtp+=$PLUGIN_DIR' \
  -c 'lua require(\"callcanvas\").setup({ settings = { [\"javaCallHierarchy.depth\"] = 1 } })' \
  -c 'edit $TARGET_FILE' \
  -c 'call cursor($TARGET_LINE,1)' \
  -c 'CallCanvas' \
  -c 'lua vim.wait(240000, function() return require(\"callcanvas\").session().url ~= nil end, 500); vim.cmd(\"qa!\")'" \
  "$WORK/pty.txt" >/dev/null 2>&1

URL="$(python3 - "$WORK/pty.txt" <<'PY'
import base64, re, sys
data = open(sys.argv[1], 'rb').read()
found = re.findall(rb'\x1b]52;c;([A-Za-z0-9+/=]+)', data)
print(base64.b64decode(found[-1]).decode() if found else '')
PY
)"

if [[ -n "$URL" ]]; then
    ok "clipboard received: $URL"
else
    bad "no OSC 52 payload was emitted"
fi

if [[ "$URL" == http*/k/* ]]; then
    ok "it is the short single-use URL"
else
    bad "expected a short /k/<key> URL, got '$URL'"
fi

# The link carries the canvas id (so a second canvas can get its own tab), which
# makes it a little longer — still typable, and far shorter than the tokened URL.
if [[ "${#URL}" -le 50 ]]; then
    ok "length ${#URL} is short enough to type by hand as a fallback"
else
    bad "URL is ${#URL} characters long"
fi

if [[ -n "$URL" ]]; then
    CODE="$(curl -s -o /dev/null -w '%{http_code}' "$URL")"
    if [[ "$CODE" == "302" ]]; then
        ok "the clipboard URL unlocks the viewer (HTTP 302 -> /)"
    else
        bad "the clipboard URL returned HTTP $CODE"
    fi
fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS: %d  FAIL: %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
