#!/usr/bin/env bash
# End-to-end smoke test: Neovim -> analysis -> browser bridge -> jump back to Neovim.
#
#   test/e2e-nvim.sh [<java file>] [<line>]
#
# Requires: nvim, node, java. Uses sample-app from this repo by default.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/callcanvas-nvim"
TARGET_FILE="${1:-$REPO_ROOT/sample-app/src/main/java/com/example/demo/service/TodoService.java}"
TARGET_LINE="${2:-34}"
# The host picks the project root itself; address the session by file.

WORK="$(mktemp -d)"
SOCK="$WORK/nvim.sock"
PASS=0
FAIL=0

step() { printf '\n=== %s\n' "$1"; }
ok()   { printf '  PASS %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }

cleanup() {
    node "$PLUGIN_DIR/src/cli.js" stop --file "$TARGET_FILE" >/dev/null 2>&1
    if [[ -n "${NVIM_PID:-}" ]]; then
        kill "$NVIM_PID" 2>/dev/null
    fi
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

# CALLCANVAS_TEST_APPNAME=<appname> runs against a real config (LazyVim) that
# already carries the plugin spec, instead of a bare `-u NONE` Neovim.
APPNAME="${CALLCANVAS_TEST_APPNAME:-}"

if [[ -n "$APPNAME" ]]; then
    step "start headless Neovim with config '$APPNAME' (plugin spec from that config)"
    NVIM_APPNAME="$APPNAME" nvim --headless --listen "$SOCK" \
        -c "edit $TARGET_FILE" \
        -c "call cursor($TARGET_LINE, 1)" \
        >"$WORK/nvim.log" 2>&1 &
    NVIM_PID=$!
else
    step "start headless Neovim with the plugin"
    nvim --headless --listen "$SOCK" -u NONE \
        --cmd "set rtp+=$PLUGIN_DIR" \
        -c "lua require('callcanvas').setup({ auto_open = false })" \
        -c "edit $TARGET_FILE" \
        -c "call cursor($TARGET_LINE, 1)" \
        >"$WORK/nvim.log" 2>&1 &
    NVIM_PID=$!
fi

for _ in $(seq 1 50); do
    [[ -S "$SOCK" ]] && break
    sleep 0.2
done
if [[ -S "$SOCK" ]]; then
    ok "nvim listening on $SOCK"
else
    bad "nvim did not create its socket"
    exit 1
fi

step "run :CallCanvas from Neovim (caret -> signature -> analysis -> viewer)"
if [[ -n "$APPNAME" ]]; then
    # Go through the user command so the lazy.nvim cmd-trigger is exercised too.
    nvim --server "$SOCK" --remote-expr "execute('CallCanvas')" >/dev/null
else
    nvim --server "$SOCK" --remote-expr \
        "luaeval(\"require('callcanvas').open() or 1\")" >/dev/null
fi

if [[ -n "$APPNAME" ]]; then
    MAPPED="$(nvim --server "$SOCK" --remote-expr "maparg(' vv', 'n')" 2>/dev/null)"
    if [[ -n "$MAPPED" ]]; then
        ok "<leader>vv is mapped by the plugin spec"
    else
        bad "<leader>vv is not mapped"
    fi
fi

SESSION=""
for _ in $(seq 1 150); do
    SESSION="$(node "$PLUGIN_DIR/src/cli.js" status --file "$TARGET_FILE" --json 2>/dev/null)"
    if [[ "$SESSION" == *'"running":true'* ]]; then
        break
    fi
    sleep 1
done
if [[ "$SESSION" == *'"running":true'* ]]; then
    ok "host session is running"
else
    bad "host session never started"
    cat "$WORK/nvim.log"
    exit 1
fi

URL="$(node -e "const s=JSON.parse(process.argv[1]); console.log(s.session.url)" "$SESSION")"
BASE="$(node -e "const u=new URL(process.argv[1]); console.log(u.origin)" "$URL")"
TOKEN="$(node -e "const u=new URL(process.argv[1]); console.log(u.searchParams.get('t'))" "$URL")"

step "fetch the viewer page ($URL)"
for _ in $(seq 1 120); do
    CODE="$(curl -s -o "$WORK/page.html" -w '%{http_code}' "$URL")"
    [[ "$CODE" == "200" ]] && break
    sleep 1
done
if [[ "$CODE" == "200" ]]; then
    ok "page served (HTTP 200)"
else
    bad "page not served (HTTP $CODE)"
fi

WINDOWS="$(node -e "
const fs = require('fs');
const html = fs.readFileSync(process.argv[1], 'utf8');
const m = html.match(/initialData: (\{[\s\S]*?\}),\n\s*jsonFilePath/);
if (!m) { console.log('0'); process.exit(0); }
console.log(JSON.parse(m[1]).windows.length);
" "$WORK/page.html")"
if [[ "${WINDOWS:-0}" -gt 1 ]]; then
    ok "canvas contains $WINDOWS windows"
else
    bad "canvas has no analysis result (windows=$WINDOWS)"
fi

if grep -q 'acquireVsCodeApi' "$WORK/page.html" || grep -q 'bridge.js' "$WORK/page.html"; then
    ok "bridge script injected"
else
    bad "bridge script missing"
fi

step "browser -> host -> Neovim jump (openFile)"
# Prefer a window in a DIFFERENT file so the jump really navigates.
JUMP_FILE="$(node -e "
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(process.argv[1], 'utf8');
const data = JSON.parse(html.match(/initialData: (\{[\s\S]*?\}),\n\s*jsonFilePath/)[1]);
const current = path.basename(process.argv[2]);
const java = data.windows.filter(w => w.filePath && w.filePath.endsWith('.java') && w.startLine > 1);
const target = java.find(w => path.basename(w.filePath) !== current) || java[0] || data.windows[0];
console.log(JSON.stringify({ filePath: target.filePath, line: target.startLine }));
" "$WORK/page.html" "$TARGET_FILE")"
echo "  jump target: $JUMP_FILE"

curl -s -o /dev/null -X POST -H 'Content-Type: application/json' \
    -d "{\"message\": $(node -e "
const t = JSON.parse(process.argv[1]);
console.log(JSON.stringify({ command: 'openFile', filePath: t.filePath, line: t.line }));
" "$JUMP_FILE")}" \
    "$BASE/api/message?t=$TOKEN"

EXPECTED_LINE="$(node -e "console.log(JSON.parse(process.argv[1]).line)" "$JUMP_FILE")"
EXPECTED_NAME="$(node -e "const p=JSON.parse(process.argv[1]).filePath; console.log(p.split('/').pop())" "$JUMP_FILE")"

CURSOR=""
for _ in $(seq 1 40); do
    CURSOR="$(nvim --server "$SOCK" --remote-expr 'expand("%:t") . ":" . line(".")' 2>/dev/null)"
    [[ "$CURSOR" == "$EXPECTED_NAME:$EXPECTED_LINE" ]] && break
    sleep 0.25
done
if [[ "$CURSOR" == "$EXPECTED_NAME:$EXPECTED_LINE" ]]; then
    ok "Neovim jumped to $CURSOR"
else
    bad "Neovim cursor is '$CURSOR', expected '$EXPECTED_NAME:$EXPECTED_LINE'"
fi

step "host rejects an unauthenticated request"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/?t=nope")"
if [[ "$CODE" == "403" ]]; then
    ok "bad token rejected"
else
    bad "bad token returned HTTP $CODE"
fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS: %d  FAIL: %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
