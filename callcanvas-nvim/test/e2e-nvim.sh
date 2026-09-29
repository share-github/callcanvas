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
        -c "lua require('callcanvas').setup({ auto_open = false, settings = { ['callcanvas.nvimJump'] = true } })" \
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
    # The index key must reach the command; it is the one people press with no
    # buffer open (from the project root), so a missing mapping is invisible.
    MAPPED_INDEX="$(nvim --server "$SOCK" --remote-expr "maparg(' vi', 'n')" 2>/dev/null)"
    if [[ "$MAPPED_INDEX" == *"CallCanvasBuildIndex"* ]]; then
        ok "<leader>vi runs :CallCanvasBuildIndex"
    else
        bad "<leader>vi maps to '$MAPPED_INDEX'"
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

# The host asks Neovim when a command needs a choice ("which project?" while building
# the call index). Headless Neovim has no UI to ask, which must answer "-1" (let the
# host fall back) rather than block on input.
step "the host can put a QuickPick to Neovim"
SELECT_HEADLESS="$(nvim --server "$SOCK" --remote-expr \
    "CallCanvasNvimSelect('which project?', ['app', 'sample-app'])" 2>/dev/null)"
if [[ "$SELECT_HEADLESS" == "-1" ]]; then
    ok "no UI attached -> the host decides (-1)"
else
    bad "headless select returned '$SELECT_HEADLESS', expected -1"
fi
# With a UI and an answer the choice comes back 0-based; 0 (Esc) means cancelled.
# The UI / input stubs are restored inside the same expression so the rest of this
# test still runs against an unmodified Neovim.
cat >"$WORK/select.lua" <<'LUA'
local uis, ask = vim.api.nvim_list_uis, vim.fn.inputlist
vim.api.nvim_list_uis = function() return { {} } end
vim.fn.inputlist = function() return 2 end
local picked = require('callcanvas').select_remote('p', { 'a', 'b' })
vim.fn.inputlist = function() return 0 end
local cancelled = require('callcanvas').select_remote('p', { 'a', 'b' })
vim.api.nvim_list_uis = uis
vim.fn.inputlist = ask
return picked .. ',' .. cancelled
LUA
SELECTED="$(nvim --server "$SOCK" --remote-expr \
    "luaeval('loadfile(_A)()', '$WORK/select.lua')" 2>/dev/null)"
if [[ "$SELECTED" == "1,-2" ]]; then
    ok "a picked item is 0-based and Esc cancels ($SELECTED)"
else
    bad "select returned '$SELECTED', expected '1,-2'"
fi

# The index is what makes incoming-call analysis fast. `:CallCanvasBuildIndex`
# goes through the CLI to the *running* host, so this also covers the long-running
# command route (the default 120 s HTTP timeout is not enough for a real project).
step "run :CallCanvasBuildIndex from Neovim (Java call index)"
PROJECT_ROOT="$(node -e "console.log(JSON.parse(process.argv[1]).projectRoot)" "$SESSION")"
INDEX_FILE="$PROJECT_ROOT/.callcanvas-cache/call-index.json"
index_mtime() { node -e "
const fs = require('fs');
try { console.log(Math.round(fs.statSync(process.argv[1]).mtimeMs)); } catch { console.log('0'); }
" "$INDEX_FILE"; }
INDEX_BEFORE="$(index_mtime)"
nvim --server "$SOCK" --remote-expr "execute('CallCanvasBuildIndex')" >/dev/null
INDEX_AFTER="$INDEX_BEFORE"
for _ in $(seq 1 300); do
    INDEX_AFTER="$(index_mtime)"
    [[ "$INDEX_AFTER" -gt "$INDEX_BEFORE" ]] && break
    sleep 1
done
if [[ "$INDEX_AFTER" -gt "$INDEX_BEFORE" ]]; then
    ok "call index rebuilt ($INDEX_FILE)"
else
    bad "call index was not rebuilt ($INDEX_FILE, mtime $INDEX_BEFORE)"
fi

if [[ -n "$APPNAME" ]]; then
    # The shipped spec leaves callcanvas.nvimJump off: the browser must be
    # self-contained and never move Neovim.
    step "browser -> host: openFile must NOT move Neovim (default)"
    BEFORE="$(nvim --server "$SOCK" --remote-expr 'winnr("$") . ":" . expand("%:t") . ":" . line(".")' 2>/dev/null)"
    curl -s -o /dev/null -X POST -H 'Content-Type: application/json' \
        -d '{"message": {"command": "openFile", "filePath": "src/main/java/com/example/demo/service/NoticeService.java", "line": 24}}' \
        "$BASE/api/message?t=$TOKEN"
    sleep 3
    AFTER="$(nvim --server "$SOCK" --remote-expr 'winnr("$") . ":" . expand("%:t") . ":" . line(".")' 2>/dev/null)"
    if [[ "$AFTER" == "$BEFORE" ]]; then
        ok "Neovim was left untouched ($AFTER)"
    else
        bad "Neovim changed although nvimJump is off: '$BEFORE' -> '$AFTER'"
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
    exit $?
fi

step "browser -> host -> Neovim jump (openFile, nvimJump=true)"
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

# Where the user was before the jump. A jump is triggered from the browser, so this
# window and cursor must still be there afterwards.
BEFORE="$(nvim --server "$SOCK" --remote-expr 'expand("%:t") . ":" . line(".")' 2>/dev/null)"

# The cursor line of whichever window ended up showing the file (-1 = none).
LANDED_EXPR="luaeval('(function() for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do local name = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(w)); if vim.fn.fnamemodify(name, \":t\") == _A[1] then return vim.api.nvim_win_get_cursor(w)[1] end end return -1 end)()', ['$EXPECTED_NAME'])"

LANDED=""
for _ in $(seq 1 40); do
    LANDED="$(nvim --server "$SOCK" --remote-expr "$LANDED_EXPR" 2>/dev/null)"
    [[ "$LANDED" == "$EXPECTED_LINE" ]] && break
    sleep 0.25
done
if [[ "$LANDED" == "$EXPECTED_LINE" ]]; then
    ok "Neovim opened $EXPECTED_NAME at line $LANDED"
else
    bad "no window shows $EXPECTED_NAME:$EXPECTED_LINE (got line '$LANDED')"
fi

AFTER="$(nvim --server "$SOCK" --remote-expr 'expand("%:t") . ":" . line(".")' 2>/dev/null)"
if [[ "$AFTER" == "$BEFORE" ]]; then
    ok "the window the user was in is untouched ($AFTER)"
else
    bad "the jump stole the current window: '$BEFORE' -> '$AFTER'"
fi

# A second jump must reuse the same window instead of splitting again.
WINS_BEFORE="$(nvim --server "$SOCK" --remote-expr 'winnr("$")' 2>/dev/null)"
curl -s -o /dev/null -X POST -H 'Content-Type: application/json' \
    -d "{\"message\": {\"command\": \"openFile\", \"filePath\": \"$(node -e "console.log(JSON.parse(process.argv[1]).filePath)" "$JUMP_FILE")\", \"line\": 1}}" \
    "$BASE/api/message?t=$TOKEN"
sleep 2
WINS_AFTER="$(nvim --server "$SOCK" --remote-expr 'winnr("$")' 2>/dev/null)"
if [[ "$WINS_AFTER" == "$WINS_BEFORE" ]]; then
    ok "repeated jumps reuse one window (still $WINS_AFTER)"
else
    bad "a repeated jump split again: $WINS_BEFORE -> $WINS_AFTER"
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
