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
    if [[ -n "${CS_REPO:-}" ]]; then
        node "$PLUGIN_DIR/src/cli.js" stop --root "$CS_REPO" >/dev/null 2>&1
        rm -rf "$(dirname "$CS_REPO")"
    fi
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
    MAPPED_CS="$(nvim --server "$SOCK" --remote-expr "maparg(' vc', 'n')" 2>/dev/null)"
    if [[ "$MAPPED_CS" == *"CallCanvasChangeSet"* ]]; then
        ok "<leader>vc runs :CallCanvasChangeSet"
    else
        bad "<leader>vc maps to '$MAPPED_CS'"
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

# Long work (analysis, and the index build that outlives it) is shown as a line that
# stays on screen. Without a UI there is nothing to draw on, which must be a no-op
# rather than an error; the stubs are restored inside the same expression.
step "the host can keep a progress line on screen in Neovim"
PROGRESS_HEADLESS="$(nvim --server "$SOCK" --remote-expr \
    "CallCanvasNvimProgress('building the call index', 1)" 2>/dev/null)"
cat >"$WORK/progress.lua" <<'LUA'
local cc = require('callcanvas')
local uis = vim.api.nvim_list_uis
local function floats()
  local n = 0
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    if vim.api.nvim_win_get_config(win).relative ~= '' then n = n + 1 end
  end
  return n
end
vim.api.nvim_list_uis = function() return { {} } end
cc.progress_remote('call index — Found 22 Java files', 1)
local shown, text = floats(), ''
for _, win in ipairs(vim.api.nvim_list_wins()) do
  if vim.api.nvim_win_get_config(win).relative ~= '' then
    text = vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(win), 0, 1, false)[1] or ''
  end
end
local window = vim.api.nvim_get_current_win()
-- An outcome worth reading stays up for a moment, then goes.
cc.progress_remote('call index built', 0)
local lingered = floats()
vim.wait(2600, function() return floats() == 0 end, 100)
local closed = floats()
-- Work that just ended (no outcome to read) takes the line down at once.
cc.progress_remote('analyzing Foo.java:31', 1)
cc.progress_remote('', 0)
local immediate = floats()
vim.api.nvim_list_uis = uis
return ('%d,%d,%d,%d,%s,%s'):format(shown, lingered, closed, immediate,
  tostring(window == vim.api.nvim_get_current_win()),
  text:find('Found 22 Java files', 1, true) and 'text' or 'no-text')
LUA
PROGRESS="$(nvim --server "$SOCK" --remote-expr \
    "luaeval('loadfile(_A)()', '$WORK/progress.lua')" 2>/dev/null)"
if [[ "$PROGRESS_HEADLESS" == "1" && "$PROGRESS" == "1,1,0,0,true,text" ]]; then
    ok "the line is drawn with its status, outlives the outcome briefly, then goes"
else
    bad "progress returned headless='$PROGRESS_HEADLESS' ui='$PROGRESS' (want 1 and 1,1,0,0,true,text)"
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

# One canvas for the changes of a commit. A throwaway git repository (two commits,
# the second adds OrderService.changeSetProbe) is its own project, so this also starts
# a second host next to the sample-app one. The Java extension copy with the new
# analyzer (when resources still has an older JAR) reaches the host through Neovim's
# environment, which `vim.system` passes on.
#
# Without an argument the commit is picked in Neovim (vim.ui.select — a picker under
# LazyVim). The stub here records the offered items and picks "直前のコミット"; the
# notifications are recorded too, to check what the user is told.
step "run :CallCanvasChangeSet (no argument) from Neovim -> pick the last commit"
FIXTURE="$(node "$PLUGIN_DIR/test/changeset-fixture.js" 2>"$WORK/fixture.err")"
if [[ -z "$FIXTURE" ]]; then
    bad "change set fixture: $(cat "$WORK/fixture.err")"
else
    CS_REPO="$(node -e "console.log(JSON.parse(process.argv[1]).repo)" "$FIXTURE")"
    CS_COMMIT="$(node -e "console.log(JSON.parse(process.argv[1]).commit)" "$FIXTURE")"
    CS_SUBJECT="$(node -e "console.log(JSON.parse(process.argv[1]).subject)" "$FIXTURE")"
    CS_ENV="$(node -e "const e=JSON.parse(process.argv[1]).env; console.log(Object.entries(e).map(([k,v])=>k+'='+v).join(' '))" "$FIXTURE")"
    for pair in $CS_ENV; do
        nvim --server "$SOCK" --remote-expr "luaeval('(function() vim.env[_A[1]] = _A[2]; return 1 end)()', ['${pair%%=*}', '${pair#*=}'])" >/dev/null
    done
    # The repository is taken from the buffer, so look at a file of that repository.
    nvim --server "$SOCK" --remote-expr \
        "execute('tabnew $CS_REPO/src/main/java/com/example/changeset/order/OrderService.java')" >/dev/null

    # Completion: live, workbench, HEAD and the recent short hashes.
    COMPLETION="$(nvim --server "$SOCK" --remote-expr "join(getcompletion('CallCanvasChangeSet ', 'cmdline'), ',')" 2>/dev/null)"
    if [[ ",$COMPLETION," == *",live,"* && ",$COMPLETION," == *",workbench,"* && ",$COMPLETION," == *",HEAD,"* && ",$COMPLETION," == *",$CS_COMMIT,"* ]]; then
        ok "completion offers live, workbench, HEAD and the commits ($COMPLETION)"
    else
        bad "completion: '$COMPLETION'"
    fi
    PREFIXED="$(nvim --server "$SOCK" --remote-expr "join(getcompletion('CallCanvasChangeSet ${CS_COMMIT:0:3}', 'cmdline'), ',')" 2>/dev/null)"
    if [[ "$PREFIXED" == *"$CS_COMMIT"* && "$PREFIXED" != *"workbench"* ]]; then
        ok "completion narrows by what is typed (${CS_COMMIT:0:3} -> $PREFIXED)"
    else
        bad "completion for '${CS_COMMIT:0:3}': '$PREFIXED'"
    fi

    cat >"$WORK/cs-stub.lua" <<'LUA'
_G.cs_offered, _G.cs_notes = nil, {}
local notify = vim.notify
vim.notify = function(msg, level, o)
  table.insert(_G.cs_notes, msg)
  return notify(msg, level, o)
end
vim.ui.select = function(items, opts, on_choice)
  _G.cs_offered = vim.tbl_map(function(item) return opts.format_item(item) end, items)
  for _, item in ipairs(items) do
    if opts.format_item(item):match('^直前のコミット') then
      return on_choice(item)
    end
  end
  on_choice(nil)
end
return 1
LUA
    nvim --server "$SOCK" --remote-expr "luaeval('loadfile(_A)()', '$WORK/cs-stub.lua')" >/dev/null
    nvim --server "$SOCK" --remote-expr "execute('CallCanvasChangeSet')" >/dev/null

    OFFERED="$(nvim --server "$SOCK" --remote-expr "luaeval('table.concat(_G.cs_offered or {}, \"\\n\")')" 2>/dev/null)"
    FIRST="$(sed -n 1p <<<"$OFFERED")"
    SECOND="$(sed -n 2p <<<"$OFFERED")"
    THIRD="$(sed -n 3p <<<"$OFFERED")"
    if [[ "$FIRST" == "ライブ（今からの変更を追う）" ]]; then
        ok "the list starts with live, following the changes from now on ($FIRST)"
    else
        bad "first item: '$FIRST'"
    fi
    if [[ "$SECOND" == "ワークベンチ（未コミットの変更: 0 ファイル）" ]]; then
        ok "then the workbench and its count, 0 with nothing uncommitted ($SECOND)"
    else
        bad "second item: '$SECOND'"
    fi
    if [[ "$THIRD" == "直前のコミット  $CS_COMMIT  $CS_SUBJECT  ("*")" ]]; then
        ok "then the last commit, readable ($THIRD)"
    else
        bad "third item: '$THIRD'"
    fi
    if [[ "$OFFERED" != *".."* && "$OFFERED" != *"範囲"* ]]; then
        ok "no range items are offered"
    else
        bad "range items offered: $OFFERED"
    fi

    CS_SESSION=""
    for _ in $(seq 1 300); do
        CS_SESSION="$(nvim --server "$SOCK" --remote-expr \
            "luaeval('vim.json.encode(require(\"callcanvas\").session())')" 2>/dev/null)"
        [[ "$CS_SESSION" == *"変更集合 $CS_COMMIT"* ]] && break
        sleep 1
    done
    CS_PERMALINK="$(node -e "console.log(JSON.parse(process.argv[1]).permalink || '')" "$CS_SESSION" 2>/dev/null)"
    CS_TITLE="$(node -e "console.log(JSON.parse(process.argv[1]).title || '')" "$CS_SESSION" 2>/dev/null)"
    if [[ "$CS_PERMALINK" == */c/*'?t='* ]]; then
        ok "picking the last commit opened its change set canvas ($CS_PERMALINK)"
    else
        bad "no change set canvas in the Neovim session: $CS_SESSION"
    fi
    if [[ "$CS_TITLE" == "変更集合 $CS_COMMIT $CS_SUBJECT" ]]; then
        ok "the canvas is named after the commit ($CS_TITLE)"
    else
        bad "canvas title: '$CS_TITLE'"
    fi
    NOTES="$(nvim --server "$SOCK" --remote-expr "luaeval('table.concat(_G.cs_notes, \"\\n\")')" 2>/dev/null)"
    HEADLINE_RE="変更集合 $CS_COMMIT（$CS_SUBJECT）: [0-9]+ ファイル / [1-9][0-9]* 島"
    if [[ "$NOTES" =~ $HEADLINE_RE ]]; then
        ok "the notification says what was opened ($(grep -m1 '変更集合 '"$CS_COMMIT" <<<"$NOTES"))"
    else
        bad "notifications: $NOTES"
    fi
    if ls "$CS_REPO"/build/call-hierarchy-output/callcanvas_changeset_*.json >/dev/null 2>&1; then
        ok "the canvas JSON is written in the repository"
    else
        bad "no callcanvas_changeset_*.json under $CS_REPO/build/call-hierarchy-output"
    fi
    CODE="$(curl -s -o "$WORK/changeset.html" -w '%{http_code}' "$CS_PERMALINK")"
    if [[ "$CODE" == "200" ]] && grep -q 'changeSetProbe' "$WORK/changeset.html"; then
        ok "/c/<id> serves the change set canvas"
    else
        bad "change set canvas not served (HTTP $CODE)"
    fi

    step ":CallCanvasChangeSet workbench with nothing uncommitted"
    nvim --server "$SOCK" --remote-expr "luaeval('(function() _G.cs_notes = {}; return 1 end)()')" >/dev/null
    nvim --server "$SOCK" --remote-expr "execute('CallCanvasChangeSet workbench')" >/dev/null
    NOTES=""
    for _ in $(seq 1 120); do
        NOTES="$(nvim --server "$SOCK" --remote-expr "luaeval('table.concat(_G.cs_notes, \"\\n\")')" 2>/dev/null)"
        [[ "$NOTES" == *"ありません"* || "$NOTES" == *"failed"* ]] && break
        sleep 1
    done
    if [[ "$NOTES" == *"ワークベンチに未コミットの変更はありません"*":CallCanvasChangeSet"* ]]; then
        ok "an empty workbench says why and what to do instead"
    else
        bad "workbench notifications: $NOTES"
    fi

    step "the workbench count follows the working tree"
    echo "// uncommitted" >>"$CS_REPO/src/main/java/com/example/changeset/order/OrderService.java"
    DIRTY="$(nvim --server "$SOCK" --remote-expr \
        "luaeval('require(\"callcanvas\").change_set_choices(_A)[2].text', '$CS_REPO')" 2>/dev/null)"
    git -C "$CS_REPO" checkout -q -- .
    if [[ "$DIRTY" == "ワークベンチ（未コミットの変更: 1 ファイル）" ]]; then
        ok "one uncommitted file shows as 1 ($DIRTY)"
    else
        bad "workbench item with one change: '$DIRTY'"
    fi
fi

step ":CallCanvasInstallSkill writes the Claude Code skill with this machine's CLI"
nvim --server "$SOCK" --remote-expr "execute('CallCanvasInstallSkill $WORK/skills')" >/dev/null 2>&1
SKILL="$WORK/skills/callcanvas-comment/SKILL.md"
if [[ -f "$SKILL" ]] && grep -q '^name: callcanvas-comment$' "$SKILL" && ! grep -q '{{' "$SKILL"; then
    ok "skill written with the placeholders filled in"
else
    bad "skill file: $(head -5 "$SKILL" 2>/dev/null)"
fi
# the command line the skill tells Claude Code to run must work as written
SKILL_CMD="$(sed -n 's/^CALLCANVAS = //p' "$SKILL" 2>/dev/null)"
mkdir -p "$WORK/empty-project"
SKILL_OUT="$(eval "$SKILL_CMD canvases --root '$WORK/empty-project'" 2>&1)"
if [[ "$SKILL_OUT" == "no canvas ("* ]]; then
    ok "the skill's command runs ($SKILL_CMD)"
else
    bad "skill command '$SKILL_CMD': $SKILL_OUT"
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
