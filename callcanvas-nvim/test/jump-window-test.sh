#!/usr/bin/env bash
# Where does a jump from the browser land?
#
# Runs the plugin's jump() directly in headless Neovim (no host, no browser) and
# checks the window it chooses. The cases come from a real failure: LazyVim's
# snacks picker keeps ordinary (non-floating) splits whose buffers are `nofile`,
# and opening a file into one of those silently replaced the user's own buffer.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_DIR/.." && pwd)"
FILE_A="${1:-$REPO_ROOT/sample-app/src/main/java/com/example/demo/service/TodoService.java}"
FILE_B="${2:-$REPO_ROOT/sample-app/src/main/java/com/example/demo/service/NoticeService.java}"
WORK="$(mktemp -d)"
PASS=0
FAIL=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

ok()  { printf '  PASS %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }

# Run a lua scenario in headless Neovim and print whatever it writes to the result
# file. `jump()` defers with vim.schedule, so each scenario waits for its effect.
scenario() {
    local name="$1"
    local lua="$2"
    : >"$WORK/out.txt"
    nvim --headless -n -u NONE \
        --cmd "set rtp+=$PLUGIN_DIR" \
        -c "lua CC = require('callcanvas'); CC.setup({ jump_focus = false })" \
        -c "lua FILE_A = '$FILE_A'; FILE_B = '$FILE_B'; OUT = '$WORK/out.txt'" \
        -c "lua $lua" \
        -c 'qa!' >"$WORK/nvim.log" 2>&1
    cat "$WORK/out.txt"
}

report() { printf '%s\n' "  $1"; }

printf '\n=== a jump must not land in a plugin UI window (buftype=nofile)\n'
RESULT="$(scenario 'ui-window' '
vim.cmd("edit " .. FILE_A)
vim.api.nvim_win_set_cursor(0, { 34, 0 })
local user_win = vim.api.nvim_get_current_win()

-- A sidebar exactly like snacks/neo-tree: ordinary split, nofile buffer.
vim.cmd("vsplit")
local ui_win = vim.api.nvim_get_current_win()
local ui_buf = vim.api.nvim_create_buf(false, true)
vim.bo[ui_buf].buftype = "nofile"
vim.bo[ui_buf].filetype = "snacks_layout_box"
vim.api.nvim_win_set_buf(ui_win, ui_buf)
vim.api.nvim_set_current_win(user_win)

CC.jump(FILE_B, 24)
vim.wait(3000, function()
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(w)) == FILE_B then return true end
  end
  return false
end, 50)

local landed_in_ui = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(ui_win)) == FILE_B
local ui_still_ui = vim.bo[vim.api.nvim_win_get_buf(ui_win)].filetype == "snacks_layout_box"
local user_file = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(user_win)), ":t")
local user_line = vim.api.nvim_win_get_cursor(user_win)[1]
local opened = false
for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  if vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(w)) == FILE_B then opened = true end
end
vim.fn.writefile({
  "landed_in_ui=" .. tostring(landed_in_ui),
  "ui_intact=" .. tostring(ui_still_ui),
  "user_file=" .. user_file,
  "user_line=" .. user_line,
  "opened=" .. tostring(opened),
  "current_is_user_win=" .. tostring(vim.api.nvim_get_current_win() == user_win),
}, OUT)
')"
report "$RESULT"
grep -q "landed_in_ui=false" <<<"$RESULT" && ok "the UI window was not used" || bad "the jump landed in the UI window"
grep -q "ui_intact=true" <<<"$RESULT" && ok "the UI window kept its own buffer" || bad "the UI window's buffer was replaced"
grep -q "opened=true" <<<"$RESULT" && ok "the file was opened somewhere" || bad "the file was not opened at all"
grep -q "user_file=TodoService.java" <<<"$RESULT" && grep -q "user_line=34" <<<"$RESULT" \
    && ok "the user's window and cursor are untouched" || bad "the user's window was disturbed"
grep -q "current_is_user_win=true" <<<"$RESULT" && ok "focus stayed with the user" || bad "focus was stolen"

printf '\n=== repeated jumps reuse one window\n'
RESULT="$(scenario 'reuse' '
vim.cmd("edit " .. FILE_A)
CC.jump(FILE_B, 24)
vim.wait(3000, function() return #vim.api.nvim_tabpage_list_wins(0) > 1 end, 50)
local after_first = #vim.api.nvim_tabpage_list_wins(0)
CC.jump(FILE_A, 10)
vim.wait(1500, function() return false end, 50)
CC.jump(FILE_B, 40)
vim.wait(1500, function() return false end, 50)
vim.fn.writefile({
  "after_first=" .. after_first,
  "after_three=" .. #vim.api.nvim_tabpage_list_wins(0),
}, OUT)
')"
report "$RESULT"
grep -q "after_first=2" <<<"$RESULT" && ok "the first jump splits once" || bad "unexpected window count after the first jump"
grep -q "after_three=2" <<<"$RESULT" && ok "three jumps still use two windows" || bad "jumps kept splitting"

printf '\n=== a closed jump window is recreated, not reused\n'
RESULT="$(scenario 'recreate' '
vim.cmd("edit " .. FILE_A)
CC.jump(FILE_B, 24)
vim.wait(3000, function() return #vim.api.nvim_tabpage_list_wins(0) > 1 end, 50)
local jump_win = CC.session().jump_win
vim.api.nvim_win_close(jump_win, true)
CC.jump(FILE_B, 24)
vim.wait(3000, function() return #vim.api.nvim_tabpage_list_wins(0) > 1 end, 50)
vim.fn.writefile({
  "windows=" .. #vim.api.nvim_tabpage_list_wins(0),
  "recreated=" .. tostring(CC.session().jump_win ~= jump_win),
}, OUT)
')"
report "$RESULT"
grep -q "windows=2" <<<"$RESULT" && grep -q "recreated=true" <<<"$RESULT" \
    && ok "a new jump window was created after the old one was closed" || bad "stale jump window reused"

printf '\n=== jump_mode = "here" replaces the current window\n'
RESULT="$(nvim --headless -n -u NONE \
    --cmd "set rtp+=$PLUGIN_DIR" \
    -c "lua CC = require('callcanvas'); CC.setup({ jump_focus = false, jump_mode = 'here' })" \
    -c "lua FILE_A = '$FILE_A'; FILE_B = '$FILE_B'; OUT = '$WORK/out2.txt'" \
    -c 'lua vim.cmd("edit " .. FILE_A); CC.jump(FILE_B, 24); vim.wait(3000, function() return vim.api.nvim_buf_get_name(0) == FILE_B end, 50); vim.fn.writefile({ "windows=" .. #vim.api.nvim_tabpage_list_wins(0), "buffer=" .. vim.fn.fnamemodify(vim.api.nvim_buf_get_name(0), ":t") }, OUT)' \
    -c 'qa!' >"$WORK/nvim2.log" 2>&1; cat "$WORK/out2.txt")"
report "$RESULT"
grep -q "windows=1" <<<"$RESULT" && grep -q "buffer=NoticeService.java" <<<"$RESULT" \
    && ok "'here' opens in place without splitting" || bad "'here' did not replace the current window"

printf '\n%s\n' "----------------------------------------"
printf 'PASS: %d  FAIL: %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
