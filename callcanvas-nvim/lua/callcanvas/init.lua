-- CallCanvas for Neovim
--
-- `:CallCanvas` analyzes the method/function under the cursor and shows the
-- result in a browser. Nothing has to be typed: the plugin only sends the
-- current file path and cursor line, and the CallCanvas extensions resolve the
-- method signature (fully qualified class + parameter types) from there.

local M = {}

local uv = vim.uv or vim.loop

M.config = {
  -- Path to the CLI (defaults to the copy shipped next to this plugin).
  cli = nil,
  -- Node binary used to run the CLI.
  node = 'node',
  -- Bind address of the local viewer server. Use '0.0.0.0' when Neovim runs in
  -- a container and the browser runs on the host.
  host = '127.0.0.1',
  port = nil,
  -- Seconds to keep the host alive after the last browser tab closes (0 = forever).
  idle_timeout = 300,
  -- Open the URL automatically (vim.ui.open / $BROWSER / open_cmd).
  auto_open = true,
  -- Explicit opener, e.g. { 'wslview' } or a helper that reaches the host browser.
  -- Takes precedence over $BROWSER and vim.ui.open.
  open_cmd = nil,
  -- Copy the URL to the + register so it can be pasted into a browser on another machine.
  copy_url = true,
  -- Extra configuration overrides, e.g. { ['callcanvas.windowWidth'] = 800 }.
  settings = {},
  -- Where a jump from the browser lands: 'split' keeps ONE dedicated window
  -- (created on the first jump and reused afterwards), 'here' replaces the current
  -- window, 'tab' uses a dedicated tab.
  jump_mode = 'split',
  -- Keep a line on screen while the host is busy (analysis, and the call index build
  -- that an analysis kicks off in the background — it outlives the analysis itself and
  -- would otherwise be a notification that scrolls away). false disables it.
  progress = true,
  -- Whether a jump moves the cursor focus to the opened file:
  --   'auto'  (default) only when Neovim actually has terminal focus
  --   true    always (the old behaviour)
  --   false   never — the file is shown but your window and cursor stay put
  -- A jump is triggered from the browser, i.e. usually while you are NOT in Neovim;
  -- stealing the window then loses the place you were working in.
  jump_focus = 'auto',
}

local state = { url = nil, short_url = nil, short_bookmark_url = nil, bookmark_url = nil,
  permalink = nil, list_url = nil, title = nil, canvas_count = 0,
  -- Terminal focus, tracked via FocusGained/FocusLost. Starts false: a jump can only
  -- come from the browser, so "not focused" is the safe assumption.
  focused = false,
  -- The one window jumps reuse, so repeated jumps do not keep splitting.
  jump_win = nil,
  -- The progress line: one reused floating window, ticking its own elapsed time.
  progress = { win = nil, buf = nil, timer = nil, text = nil, started = 0, frame = 1, closing = nil } }

local function plugin_root()
  local source = debug.getinfo(1, 'S').source:sub(2)
  -- <root>/lua/callcanvas/init.lua -> <root>
  return vim.fn.fnamemodify(source, ':h:h:h')
end

local function cli_path()
  return M.config.cli or (plugin_root() .. '/src/cli.js')
end

local function notify(message, level)
  vim.notify('[CallCanvas] ' .. message, level or vim.log.levels.INFO)
end

--- Put text on the clipboard of the machine running the terminal.
--- Uses OSC 52 explicitly: inside a container there is no clipboard provider, but
--- the terminal emulator (iTerm2 / Ghostty / WezTerm / Kitty / tmux with
--- set-clipboard on) can still receive it, so cmd-V works on the host.
local function clipboard_copy(text)
  local copied = false
  -- Only touch the register when a provider exists, otherwise Neovim prints
  -- "clipboard: No provider" on every call.
  if vim.fn.has('clipboard') == 1 then
    copied = pcall(vim.fn.setreg, '+', text) or copied
  end
  local ok, osc52 = pcall(require, 'vim.ui.clipboard.osc52')
  if ok and osc52 and osc52.copy and #vim.api.nvim_list_uis() > 0 then
    copied = pcall(osc52.copy('+'), { text }) or copied
  end
  return copied
end

--- Can this machine actually put a browser on screen?
--- `xdg-open` exists in many containers but silently does nothing without a
--- desktop session, so treat "no DISPLAY and no $BROWSER" as "cannot open".
local function can_open_browser()
  if M.config.open_cmd then
    return true
  end
  if vim.env.BROWSER and vim.env.BROWSER ~= '' then
    return true
  end
  if vim.fn.has('mac') == 1 or vim.fn.has('win32') == 1 then
    return true
  end
  return (vim.env.DISPLAY or vim.env.WAYLAND_DISPLAY) ~= nil
end

--- Show (and if possible open) the viewer URL.
--- `attached` means a browser tab is already connected: it reloads itself, so
--- there is nothing to open or copy.
--- `headline` (optional) says what was opened, e.g. a change set's summary; it then
--- leads the message instead of the canvas title.
local function open_url(url, attached, headline)
  -- The link always points at the canvas that was just analysed, so pasting it in
  -- a NEW tab gives a second canvas side by side instead of moving the tab that
  -- follows the newest one.
  local shown = state.short_url or url
  if attached then
    local copied = M.config.copy_url and clipboard_copy(shown)
    local lines = { headline and (headline .. ' — 開いているタブを更新しました')
      or 'updated — your open tab reloaded itself' }
    if state.canvas_count and state.canvas_count > 1 then
      table.insert(lines, ('%d canvases open · new tab: %s%s'):format(
        state.canvas_count, shown, copied and ' (copied)' or ''))
    end
    notify(table.concat(lines, '\n'))
    return
  end

  -- Prefer the short link: the long `?t=<48 hex>` URL is unusable in a terminal
  -- notification.
  local copied = M.config.copy_url and clipboard_copy(shown)

  if headline then
    -- Says what was opened and where it went in one line; the URL follows for a
    -- browser on another machine.
    local lines = { headline .. (copied and ' — URL をコピーしました' or ''), shown }
    if M.config.auto_open and can_open_browser() then
      lines[1] = headline .. ' — ブラウザで開きます'
    end
    notify(table.concat(lines, '\n'))
    if not M.config.auto_open or not can_open_browser() then
      return
    end
  end

  if not M.config.auto_open then
    notify(shown)
    return
  end

  if not can_open_browser() then
    -- Container / remote session: the browser lives on another machine.
    local lines = {}
    table.insert(lines, (state.title and (state.title .. ' — ') or '') .. shown)
    if copied then
      table.insert(lines, '(copied · paste in a NEW tab to keep the other canvases open)')
    else
      table.insert(lines, '(paste in a NEW tab to keep the other canvases open)')
    end
    if state.bookmark_url then
      table.insert(lines, 'bookmark (always newest): ' .. state.bookmark_url)
    end
    notify(table.concat(lines, '\n'))
    return
  end

  if M.config.open_cmd then
    vim.system(vim.list_extend(vim.deepcopy(M.config.open_cmd), { shown }), { detach = true })
    if not headline then
      notify('opened in the browser')
    end
    return
  end
  if vim.env.BROWSER and vim.env.BROWSER ~= '' then
    vim.system({ vim.env.BROWSER, shown }, { detach = true })
    if not headline then
      notify('opened in the browser')
    end
    return
  end

  local handle, err = vim.ui.open(shown)
  if handle then
    if not headline then
      notify('opened in the browser')
    end
  else
    notify((err or 'could not open a browser') .. '\n' .. shown, vim.log.levels.WARN)
  end
end

local run_open

--- Build the argument list for `callcanvas open` (or `changeset`, which starts and
--- reuses the same host). `extra` comes right after the subcommand.
local function open_args(file, line, subcommand, extra)
  local args = { M.config.node, cli_path(), subcommand or 'open' }
  vim.list_extend(args, extra or {})
  vim.list_extend(args, {
    '--file', file,
    '--line', tostring(line),
    '--nvim', vim.v.servername,
    -- The host exits together with this Neovim (quit, crash or kill).
    '--nvim-pid', tostring(vim.fn.getpid()),
    '--json',
  })
  if M.config.host then
    table.insert(args, '--host')
    table.insert(args, M.config.host)
  end
  if M.config.port then
    table.insert(args, '--port')
    table.insert(args, tostring(M.config.port))
  end
  if M.config.idle_timeout ~= nil then
    table.insert(args, '--idle-timeout')
    table.insert(args, tostring(M.config.idle_timeout))
  end
  for key, value in pairs(M.config.settings or {}) do
    table.insert(args, '--set')
    table.insert(args, key .. '=' .. tostring(value))
  end
  return args
end

--- Analyze the symbol under the cursor and show it in the browser.
function M.open(opts)
  opts = opts or {}
  local file = opts.file or vim.api.nvim_buf_get_name(0)
  if file == '' then
    notify('the current buffer has no file name', vim.log.levels.ERROR)
    return
  end
  if vim.bo.modified then
    notify('buffer has unsaved changes — analyzing the file on disk', vim.log.levels.WARN)
  end
  local line = opts.line or vim.api.nvim_win_get_cursor(0)[1]

  if vim.v.servername == '' then
    notify('no servername: start Neovim with --listen or set v:servername so jumps can come back', vim.log.levels.WARN)
  end

  notify('analyzing ' .. vim.fn.fnamemodify(file, ':t') .. ':' .. line .. ' ...')
  run_open(open_args(file, line))
end

--- Run `callcanvas open`/`changeset` and show (copy) the canvas URL it answers with.
--- `opts.headline(payload)` names what was opened; `opts.failed(err)` rewords a failure
--- (both optional — the change set uses them).
run_open = function(args, opts)
  opts = opts or {}
  vim.system(args, { text = true }, function(result)
    vim.schedule(function()
      if result.code ~= 0 then
        local err = (result.stderr or ''):gsub('%s+$', '')
        if opts.failed and opts.failed(err) then
          return
        end
        notify('failed: ' .. (err ~= '' and err or ('exit ' .. result.code)), vim.log.levels.ERROR)
        return
      end
      local ok, payload = pcall(vim.json.decode, result.stdout or '')
      local url = ok and payload and payload.url or (result.stdout or ''):gsub('%s+$', '')
      if not url or url == '' then
        notify('host returned no URL', vim.log.levels.ERROR)
        return
      end
      state.url = url
      state.short_url = ok and payload and payload.shortUrl or nil
      state.short_bookmark_url = ok and payload and payload.shortBookmarkUrl or nil
      state.bookmark_url = ok and payload and payload.bookmarkUrl or nil
      state.permalink = ok and payload and payload.permalink or nil
      state.list_url = ok and payload and payload.canvasListUrl or nil
      state.title = ok and payload and payload.title or nil
      state.canvas_count = (ok and payload and payload.canvasCount) or 1
      local attached = ok and payload and (payload.clients or 0) > 0
      local headline = ok and type(payload) == 'table' and opts.headline and opts.headline(payload) or nil
      open_url(url, attached, headline)
    end)
  end)
end

-- --- change set -------------------------------------------------------------------
-- What a change set canvas shows is the same two things as the viewer's diff display
-- ("📝 コミット変更" / "📄 ワークベンチ"): one commit, or the workbench (git diff HEAD).

-- How many recent commits the list offers.
local RECENT_COMMIT_COUNT = 20

-- The argument that means the workbench (`:CallCanvasChangeSet workbench`).
local WORKBENCH_ARG = 'workbench'

-- The argument that starts a live change set (`:CallCanvasChangeSet live`): the working
-- tree as it is now is the base, and the canvas follows what changes from here on (the
-- Claude Code hook installed by :CallCanvasInstallHook tells the host).
local LIVE_ARG = 'live'

--- Lines of a git command's stdout, or nil when it failed.
local function git_lines(dir, args)
  local ok, result = pcall(function()
    return vim.system(vim.list_extend({ 'git', '-C', dir }, args), { text = true }):wait()
  end)
  if not ok or not result or result.code ~= 0 then
    return nil
  end
  return vim.split((result.stdout or ''):gsub('%s+$', ''), '\n', { trimempty = true })
end

--- The file the change set is anchored at: the current buffer, or the cwd without one.
local function change_set_anchor(file)
  file = file or vim.api.nvim_buf_get_name(0)
  if file == '' or vim.fn.filereadable(file) == 0 then
    return vim.fn.getcwd()
  end
  return file
end

--- The git repository of the anchor (its toplevel), or nil.
local function change_set_repo(anchor)
  local dir = vim.fn.isdirectory(anchor) == 1 and anchor or vim.fn.fnamemodify(anchor, ':h')
  local lines = git_lines(dir, { 'rev-parse', '--show-toplevel' })
  return lines and lines[1] or nil
end

--- The recent commits: { hash, subject, date } (date is relative, "2 days ago").
local function recent_commits(repo)
  local commits = {}
  for _, line in ipairs(git_lines(repo, {
    'log', '-' .. RECENT_COMMIT_COUNT, '--no-color', '--format=%h%x09%cr%x09%s',
  }) or {}) do
    local hash, date, subject = line:match('^([^\t]*)\t([^\t]*)\t(.*)$')
    if hash then
      table.insert(commits, { hash = hash, subject = subject, date = date })
    end
  end
  return commits
end

--- The choices for :CallCanvasChangeSet without an argument, in order: live (follow
--- the changes from now on), the workbench (with its file count, so an empty one shows
--- as 0), then the commits, newest first.
--- Each is { text = <shown>, target = <hash | 'workbench' | 'live'> }.
function M.change_set_choices(repo)
  -- Same files as the viewer's workbench: git diff HEAD (tracked files only).
  local workbench = git_lines(repo, { 'diff', 'HEAD', '--name-only' }) or {}
  local choices = {
    { text = 'ライブ（今からの変更を追う）', target = LIVE_ARG },
    { text = ('ワークベンチ（未コミットの変更: %d ファイル）'):format(#workbench), target = WORKBENCH_ARG },
  }
  for index, commit in ipairs(recent_commits(repo)) do
    local text = ('%s  %s  (%s)'):format(commit.hash, commit.subject, commit.date)
    if index == 1 then
      text = '直前のコミット  ' .. text
    end
    table.insert(choices, { text = text, target = commit.hash })
  end
  return choices
end

--- "変更集合 <hash>（<subject>）: N ファイル / M 島" from the host's answer.
local function change_set_headline(target, payload)
  local cs = type(payload.changeSet) == 'table' and payload.changeSet or {}
  local function value(v) return v ~= vim.NIL and v or nil end
  local name
  if cs.kind == 'live' then
    return ('変更集合 ライブ: %d ファイル / %d 島（ブラウザの「取り込む」で最新に）'):format(cs.fileCount or 0, cs.islandCount or 0)
  elseif cs.kind == 'workbench' then
    name = 'ワークベンチ'
  else
    local subject = value(cs.subject)
    name = (value(cs.commit) or target) .. (subject and ('（' .. subject .. '）') or '')
  end
  return ('変更集合 %s: %d ファイル / %d 島'):format(name, cs.fileCount or 0, cs.islandCount or 0)
end

--- Why a change set came out empty, and what to do instead. The viewer says it like
--- its diff display does ("ワークベンチの変更: 0 ファイル").
local function change_set_failed(target, err)
  if not err:match(': 0 ファイル') then
    return false
  end
  if target == WORKBENCH_ARG then
    notify('ワークベンチに未コミットの変更はありません（0 ファイル）。'
      .. 'コミットの変更は :CallCanvasChangeSet の一覧でコミットを選んでください', vim.log.levels.WARN)
  else
    notify(('コミット %s に変更はありません（0 ファイル）。別のコミットを :CallCanvasChangeSet で選んでください'):format(target),
      vim.log.levels.WARN)
  end
  return true
end

--- Build the canvas for a target that is already decided (a hash or 'workbench').
local function run_change_set(target, anchor)
  local label = (target == WORKBENCH_ARG and 'ワークベンチ') or (target == LIVE_ARG and 'ライブ') or target
  notify('変更集合を作成中: ' .. label .. ' ...')
  run_open(open_args(anchor, 1, 'changeset', { target }), {
    headline = function(payload)
      local cs = type(payload.changeSet) == 'table' and payload.changeSet or {}
      if cs.kind == 'live' and cs.hookInstalled == false then
        -- Without the hook nothing tells the host that the working tree changed.
        vim.schedule(function()
          notify('Claude Code の hook が未設定のため、ライブは AI の変更を追従しません。'
            .. ':CallCanvasInstallHook を 1 回実行し、Claude Code を起動し直してください', vim.log.levels.WARN)
        end)
      end
      return change_set_headline(target, payload)
    end,
    failed = function(err) return change_set_failed(target, err) end,
  })
end

--- One canvas for the changes of a commit (`hash`) or of the workbench (`workbench`,
--- the uncommitted changes — git diff HEAD).
---
--- Without an argument the target is chosen here first (vim.ui.select — a picker
--- under LazyVim): the workbench, then the recent commits. The host then gets the
--- target, so it never asks itself. The canvas opens like :CallCanvas's (URL copied,
--- /c/<id>), next to the others. The anchor is the current buffer, or the cwd.
function M.change_set(target, opts)
  opts = opts or {}
  local anchor = change_set_anchor(opts.file)
  target = vim.trim(target or '')
  if target ~= '' then
    local lower = target:lower()
    run_change_set((lower == WORKBENCH_ARG or lower == LIVE_ARG) and lower or target, anchor)
    return
  end
  local repo = change_set_repo(anchor)
  if not repo then
    notify('git リポジトリではありません: ' .. anchor, vim.log.levels.ERROR)
    return
  end
  vim.ui.select(M.change_set_choices(repo), {
    prompt = '変更集合キャンバス: どの変更を見ますか',
    format_item = function(choice) return choice.text end,
  }, function(choice)
    if choice then
      run_change_set(choice.target, anchor)
    end
  end)
end

--- Completion for :CallCanvasChangeSet: live, workbench, HEAD and the recent short hashes.
function M.complete_change_set(arglead)
  local candidates = { LIVE_ARG, WORKBENCH_ARG, 'HEAD' }
  local repo = change_set_repo(change_set_anchor())
  if repo then
    for _, commit in ipairs(recent_commits(repo)) do
      table.insert(candidates, commit.hash)
    end
  end
  return vim.tbl_filter(function(candidate)
    return vim.startswith(candidate, arglead or '')
  end, candidates)
end

--- Open the viewer URL of the running session again.
function M.browse()
  if not state.url then
    notify('no session yet — run :CallCanvas first', vim.log.levels.WARN)
    return
  end
  open_url(state.url)
end

--- Return the current session URL (and copy it to the + register).
function M.url()
  if not state.url then
    notify('no session yet — run :CallCanvas first', vim.log.levels.WARN)
    return nil
  end
  local primary = state.short_url or state.bookmark_url or state.url
  if M.config.copy_url then
    clipboard_copy(primary)
  end
  local lines = {}
  if state.short_url then
    table.insert(lines, ('this canvas%s: %s  (copied — new tab for a second canvas)'):format(
      state.title and (' (' .. state.title .. ')') or '', state.short_url))
  end
  if state.short_bookmark_url then
    table.insert(lines, 'newest canvas    : ' .. state.short_bookmark_url)
  end
  if state.bookmark_url then
    table.insert(lines, 'bookmark         : ' .. state.bookmark_url)
  end
  if state.list_url then
    table.insert(lines, 'all canvases     : ' .. state.list_url)
  end
  notify(table.concat(lines, '\n'))
  return state.url
end

--- Current session URLs without notifying (for scripting / tests).
function M.session()
  return {
    url = state.url,
    short_url = state.short_url,
    short_bookmark_url = state.short_bookmark_url,
    bookmark_url = state.bookmark_url,
    permalink = state.permalink,
    list_url = state.list_url,
    title = state.title,
    canvas_count = state.canvas_count,
    focused = state.focused,
    jump_win = state.jump_win,
  }
end

--- Open the list of canvases currently held by the host.
function M.list()
  if not state.list_url then
    notify('no session yet — run :CallCanvas first', vim.log.levels.WARN)
    return
  end
  open_url(state.list_url, false)
end

--- Stop the host process for this project.
function M.stop()
  local args = { M.config.node, cli_path(), 'stop' }
  local file = vim.api.nvim_buf_get_name(0)
  if file ~= '' then
    table.insert(args, '--file')
    table.insert(args, file)
  end
  -- The host is going away, so nothing is running any more. (Through M, because the
  -- progress helpers are defined further down.)
  M.progress_remote('', 0)
  vim.system(args, { text = true }, function(result)
    vim.schedule(function()
      state.url = nil
      state.short_url = nil
      state.short_bookmark_url = nil
      state.bookmark_url = nil
      state.canvas_count = 0
      state.permalink = nil
      state.list_url = nil
      notify((result.stdout or 'stopped'):gsub('%s+$', ''))
    end)
  end)
end

--- Build the Java call index for this project.
---
--- The index is what makes incoming-call analysis (and class-level export) fast.
--- The Java extension builds it in the background when an analysis needs it; this is
--- the explicit "build it now" route, for when you would rather wait once than have
--- the first analysis be slow. Java only — JS/TS analysis uses no index.
---
--- It runs for minutes on a large project, so it is fire-and-forget: the host keeps
--- building even if the browser is closed, and the result arrives as a notification.
function M.build_index(opts)
  opts = opts or {}
  local args = { M.config.node, cli_path(), 'build-index' }
  local file = opts.file or vim.api.nvim_buf_get_name(0)
  if file ~= '' then
    -- The project is resolved from this file, which also skips the
    -- "which project?" prompt when the buffer is a Java file.
    table.insert(args, '--file')
    table.insert(args, file)
  end
  -- Deliberately no --host/--port: when a host is already running this goes through
  -- it, and otherwise the CLI starts a throwaway one that nothing has to reach from a
  -- browser. Pinning it to the configured port (7333 in the LazyVim spec) would fail
  -- with EADDRINUSE whenever another project's host holds it.

  notify('building the call index — this can take several minutes ...')

  vim.system(args, { text = true }, function(result)
    vim.schedule(function()
      -- The extensions print to stdout while activating, so the JSON result is the
      -- LAST line, not the whole output.
      local last = ''
      for line in (result.stdout or ''):gmatch('[^\r\n]+') do
        last = line
      end
      local ok, payload = pcall(vim.json.decode, last)
      if result.code == 0 and (not ok or type(payload) ~= 'table' or payload.ok ~= false) then
        -- The extension's own toast reaches Neovim only while no browser tab is
        -- attached (otherwise it goes to the tab), so say it here as well: this is
        -- the only signal that the wait is over.
        notify('call index built')
        return
      end
      local err = (ok and type(payload) == 'table' and payload.error)
        or (result.stderr or ''):gsub('%s+$', '')
      notify('building the call index failed: '
        .. (err ~= '' and err or ('exit ' .. result.code)), vim.log.levels.ERROR)
    end)
  end)
end

--- Write the `callcanvas-comment` Claude Code skill (skill/callcanvas-comment/SKILL.md.tmpl with this
--- machine's CLI command filled in) so Claude Code in any repository can comment on canvases.
--- Pure Lua file I/O: no shell, works the same in a container, on macOS and on Windows.
--- `skills_dir` defaults to $CLAUDE_CONFIG_DIR/skills or ~/.claude/skills.
function M.install_skill(skills_dir)
  local template = plugin_root() .. '/skill/callcanvas-comment/SKILL.md.tmpl'
  local ok, lines = pcall(vim.fn.readfile, template)
  if not ok or #lines == 0 then
    notify('skill template not found: ' .. template, vim.log.levels.ERROR)
    return nil
  end
  if not skills_dir or skills_dir == '' then
    local config_dir = vim.env.CLAUDE_CONFIG_DIR
    if not config_dir or config_dir == '' then
      config_dir = vim.fn.expand('~') .. '/.claude'
    end
    skills_dir = config_dir .. '/skills'
  end
  local slash = function(p) return (vim.fn.fnamemodify(p, ':p'):gsub('\\', '/')) end
  local node = vim.fn.exepath(M.config.node)
  node = (node ~= '' and slash(node)) or M.config.node
  local command = string.format('"%s" "%s"', node, slash(cli_path()))
  for i, line in ipairs(lines) do
    lines[i] = line:gsub('{{CALLCANVAS}}', function() return command end)
  end
  local dir = vim.fn.fnamemodify(skills_dir, ':p'):gsub('[/\\]$', '') .. '/callcanvas-comment'
  vim.fn.mkdir(dir, 'p')
  local target = dir .. '/SKILL.md'
  if vim.fn.writefile(lines, target) ~= 0 then
    notify('could not write ' .. target, vim.log.levels.ERROR)
    return nil
  end
  notify('Claude Code skill installed: ' .. target)
  return target
end

--- Add the Claude Code hooks that keep live change sets following the AI
--- (`callcanvas install-hook`: `callcanvas notify` after every tool call and when a turn
--- ends, in ~/.claude/settings.json). With `remove`, take them out again.
function M.install_hook(remove)
  local args = { M.config.node, cli_path(), 'install-hook' }
  if remove then
    table.insert(args, '--remove')
  end
  local result = vim.system(args, { text = true }):wait()
  if result.code ~= 0 then
    notify(((result.stderr or '') .. (result.stdout or '')):gsub('%s+$', ''), vim.log.levels.ERROR)
    return false
  end
  notify((result.stdout or ''):gsub('%s+$', ''))
  return true
end

--- Print host status.
function M.status()
  local args = { M.config.node, cli_path(), 'status' }
  local file = vim.api.nvim_buf_get_name(0)
  if file ~= '' then
    table.insert(args, '--file')
    table.insert(args, file)
  end
  vim.system(args, { text = true }, function(result)
    vim.schedule(function()
      notify((result.stdout or ''):gsub('%s+$', ''))
    end)
  end)
end

-- Plugin UI windows that happen to use ordinary (non-floating) splits. Opening a
-- file into one of these does not fail loudly: the buffer gets relocated into
-- another window instead, which silently replaces whatever the user had there.
local UI_FILETYPE_PATTERNS = {
  '^snacks', 'neo%-tree', 'NvimTree', 'trouble', '^Outline', '^aerial', 'undotree',
  '^dap', '^fugitive', '^oil', '^qf$', '^help$', '^man$', '^netrw$', '^TelescopePrompt$',
  '^lazy$', '^mason$', '^checkhealth$', '^notify$', '^noice',
}

--- Can a file be opened in this window without disturbing something else?
local function usable_window(win)
  if not win or not vim.api.nvim_win_is_valid(win) then
    return false
  end
  if vim.api.nvim_win_get_config(win).relative ~= '' then
    return false                                   -- floating
  end
  local buf = vim.api.nvim_win_get_buf(win)
  if vim.bo[buf].buftype ~= '' then
    return false                                   -- nofile / prompt / terminal / quickfix …
  end
  local ok, fixed = pcall(function() return vim.wo[win].winfixbuf end)
  if ok and fixed then
    return false                                   -- the window refuses buffer changes
  end
  local filetype = vim.bo[buf].filetype or ''
  for _, pattern in ipairs(UI_FILETYPE_PATTERNS) do
    if filetype:match(pattern) then
      return false
    end
  end
  return true
end

--- Windows of the current tab a file may be opened in.
local function usable_windows()
  return vim.tbl_filter(usable_window, vim.api.nvim_tabpage_list_wins(0))
end

local function window_showing(file)
  for _, win in ipairs(usable_windows()) do
    if vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win)) == file then
      return win
    end
  end
  return nil
end

--- Pick the window a jump should land in, without multiplying splits and without
--- ever landing in a plugin UI window.
local function target_window(file, current)
  local showing = window_showing(file)
  if showing then
    return showing
  end
  if M.config.jump_mode == 'here' and usable_window(current) then
    return current
  end
  -- Reuse the window earlier jumps used (re-checked: it may have become a UI window
  -- or been closed since).
  if state.jump_win and state.jump_win ~= current and usable_window(state.jump_win) then
    return state.jump_win
  end
  if M.config.jump_mode == 'tab' then
    vim.cmd('tabnew')
    state.jump_win = vim.api.nvim_get_current_win()
    return state.jump_win
  end
  -- 'split': use another real file window if the tab already has one, else split.
  for _, win in ipairs(usable_windows()) do
    if win ~= current then
      state.jump_win = win
      return win
    end
  end
  -- Split off a real file window; a UI window cannot be split into a file window.
  local base = usable_window(current) and current or usable_windows()[1]
  if base then
    vim.api.nvim_set_current_win(base)
    vim.cmd('vsplit')
  else
    vim.cmd('tabnew')
  end
  state.jump_win = vim.api.nvim_get_current_win()
  return state.jump_win
end

--- Called by the host (via `nvim --server ... --remote-expr`) to jump to a location.
function M.jump(file, line)
  vim.schedule(function()
    local ok, err = pcall(function()
      local previous = vim.api.nvim_get_current_win()
      local win = target_window(file, previous)
      vim.api.nvim_set_current_win(win)
      vim.cmd('edit ' .. vim.fn.fnameescape(file))
      local count = vim.api.nvim_buf_line_count(0)
      vim.api.nvim_win_set_cursor(0, { math.min(math.max(1, line), count), 0 })
      vim.cmd('normal! zz')

      -- Hand the seat back: the jump was triggered from the browser, so the window
      -- and cursor the user left behind must still be there when they return.
      local follow = M.config.jump_focus
      if follow == 'auto' then
        follow = state.focused
      end
      if not follow and win ~= previous and vim.api.nvim_win_is_valid(previous) then
        vim.api.nvim_set_current_win(previous)
      end
    end)
    if not ok then
      notify('jump failed: ' .. tostring(err), vim.log.levels.ERROR)
    end
  end)
  return 1
end

--- Called by the host to show a message in Neovim.
function M.notify_remote(text, level)
  local levels = {
    info = vim.log.levels.INFO,
    warning = vim.log.levels.WARN,
    error = vim.log.levels.ERROR,
  }
  vim.schedule(function()
    notify(text, levels[level] or vim.log.levels.INFO)
  end)
  return 1
end

--- Called by the host when it needs a value typed by the user.
--- Runs inside a synchronous --remote-expr call, so input() blocks until answered.
-- --- progress line ---------------------------------------------------------------
-- The host pushes text; the elapsed time and the spinner tick here, so a minutes-long
-- index build costs one RPC per status change instead of one per frame.

local SPINNER = { '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏' }

local function progress_close()
  local p = state.progress
  if p.timer then
    p.timer:stop()
    p.timer:close()
    p.timer = nil
  end
  if p.closing then
    p.closing:stop()
    p.closing:close()
    p.closing = nil
  end
  if p.win and vim.api.nvim_win_is_valid(p.win) then
    pcall(vim.api.nvim_win_close, p.win, true)
  end
  if p.buf and vim.api.nvim_buf_is_valid(p.buf) then
    pcall(vim.api.nvim_buf_delete, p.buf, { force = true })
  end
  p.win, p.buf, p.text = nil, nil, nil
end

--- Draw the line, creating the window on first use.
--- Bottom right, not focusable, no autocmds: it must never take the cursor or fire
--- events in the middle of whatever the user is doing.
local function progress_draw(line)
  local p = state.progress
  if not p.buf or not vim.api.nvim_buf_is_valid(p.buf) then
    p.buf = vim.api.nvim_create_buf(false, true)
    vim.bo[p.buf].bufhidden = 'wipe'
  end
  pcall(vim.api.nvim_buf_set_lines, p.buf, 0, -1, false, { line })
  local width = math.min(vim.o.columns - 2, math.max(20, vim.fn.strdisplaywidth(line) + 2))
  local config = {
    relative = 'editor',
    anchor = 'SE',
    row = vim.o.lines - 1,
    col = vim.o.columns,
    width = width,
    height = 1,
    style = 'minimal',
    border = 'rounded',
    focusable = false,
    noautocmd = true,
    zindex = 200,
  }
  if p.win and vim.api.nvim_win_is_valid(p.win) then
    pcall(vim.api.nvim_win_set_config, p.win, config)
  else
    local ok, win = pcall(vim.api.nvim_open_win, p.buf, false, config)
    if not ok then
      return
    end
    p.win = win
    pcall(function()
      vim.wo[win].winhighlight = 'NormalFloat:NormalFloat,FloatBorder:FloatBorder'
    end)
  end
end

local function progress_tick()
  local p = state.progress
  if not p.text then
    return
  end
  p.frame = (p.frame % #SPINNER) + 1
  local seconds = math.floor((vim.uv or vim.loop).now() / 1000) - p.started
  progress_draw((' %s %s (%ds)'):format(SPINNER[p.frame], p.text, math.max(0, seconds)))
end

--- Show (or clear) the host's progress line. Called by the host over RPC.
--- @param text string
--- @param active number|boolean 0/false clears it
function M.progress_remote(text, active)
  local on = active == true or active == 1
  -- Nothing to draw on (headless, or the user turned it off).
  if M.config.progress == false or #vim.api.nvim_list_uis() == 0 then
    return 1
  end
  local p = state.progress
  if not on then
    -- No text: the work simply ended, so the line goes away at once. With text it is
    -- an outcome worth reading ('call index built'), so leave it up for a moment.
    if text == nil or text == '' then
      progress_close()
      return 1
    end
    if p.text == nil and p.win == nil then
      return 1
    end
    progress_draw((' %s'):format(text))
    if p.timer then
      p.timer:stop()
      p.timer:close()
      p.timer = nil
    end
    p.text = nil
    if p.closing then
      p.closing:stop()
      p.closing:close()
    end
    p.closing = (vim.uv or vim.loop).new_timer()
    p.closing:start(2000, 0, vim.schedule_wrap(progress_close))
    return 1
  end

  if p.closing then
    p.closing:stop()
    p.closing:close()
    p.closing = nil
  end
  if p.text == nil then
    p.started = math.floor((vim.uv or vim.loop).now() / 1000)
    p.frame = 1
  end
  p.text = text
  progress_tick()
  if not p.timer then
    p.timer = (vim.uv or vim.loop).new_timer()
    p.timer:start(400, 400, vim.schedule_wrap(progress_tick))
  end
  return 1
end

--- Answer a host-side QuickPick ("which project?" when the call index is built
--- without a Java buffer open) inside Neovim.
--- @return number 0-based choice, -1 when nobody can be asked (headless), -2 = cancelled
function M.select_remote(prompt, items)
  items = items or {}
  -- No UI attached (headless, or a detached host with nobody watching): there is no
  -- one to ask, so let the host fall back instead of blocking on input.
  if #vim.api.nvim_list_uis() == 0 or #items == 0 then
    return -1
  end
  local lines = { prompt ~= '' and prompt or 'Select' }
  for index, item in ipairs(items) do
    table.insert(lines, index .. ': ' .. tostring(item))
  end
  local ok, choice = pcall(vim.fn.inputlist, lines)
  if not ok or type(choice) ~= 'number' or choice < 1 or choice > #items then
    return -2                                  -- cancelled (0 / Esc / out of range)
  end
  return choice - 1
end

function M.prompt(message, default_value)
  local ok, answer = pcall(vim.fn.input, message, default_value or '')
  if not ok then
    return ''
  end
  return answer or ''
end

function M.setup(opts)
  M.config = vim.tbl_deep_extend('force', M.config, opts or {})

  -- Terminal focus: a jump only steals the cursor when the user is actually here.
  local group = vim.api.nvim_create_augroup('CallCanvasFocus', { clear = true })
  vim.api.nvim_create_autocmd('FocusGained', {
    group = group,
    callback = function() state.focused = true end,
  })
  vim.api.nvim_create_autocmd('FocusLost', {
    group = group,
    callback = function() state.focused = false end,
  })

  -- VimL entry points for `nvim --server ... --remote-expr`.
  vim.cmd([[
    function! CallCanvasNvimJump(file, line) abort
      return luaeval("require('callcanvas').jump(_A[1], _A[2])", [a:file, a:line])
    endfunction
    function! CallCanvasNvimNotify(text, level) abort
      return luaeval("require('callcanvas').notify_remote(_A[1], _A[2])", [a:text, a:level])
    endfunction
    function! CallCanvasNvimInput(prompt, default) abort
      return luaeval("require('callcanvas').prompt(_A[1], _A[2])", [a:prompt, a:default])
    endfunction
    function! CallCanvasNvimSelect(prompt, items) abort
      return luaeval("require('callcanvas').select_remote(_A[1], _A[2])", [a:prompt, a:items])
    endfunction
    function! CallCanvasNvimProgress(text, active) abort
      return luaeval("require('callcanvas').progress_remote(_A[1], _A[2])", [a:text, a:active])
    endfunction
  ]])

  vim.api.nvim_create_user_command('CallCanvas', function()
    M.open()
  end, { desc = 'CallCanvas: analyze the symbol under the cursor and open the viewer' })

  vim.api.nvim_create_user_command('CallCanvasBrowse', function()
    M.browse()
  end, { desc = 'CallCanvas: reopen the viewer URL' })

  vim.api.nvim_create_user_command('CallCanvasList', function()
    M.list()
  end, { desc = 'CallCanvas: list open canvases' })

  vim.api.nvim_create_user_command('CallCanvasUrl', function()
    M.url()
  end, { desc = 'CallCanvas: show/copy the viewer URL' })

  vim.api.nvim_create_user_command('CallCanvasStop', function()
    M.stop()
  end, { desc = 'CallCanvas: stop the viewer host for this project' })

  vim.api.nvim_create_user_command('CallCanvasBuildIndex', function()
    M.build_index()
  end, { desc = 'CallCanvas: build the Java call index for this project' })

  vim.api.nvim_create_user_command('CallCanvasChangeSet', function(cmd)
    M.change_set(cmd.args)
  end, {
    nargs = '?',
    complete = function(arglead) return M.complete_change_set(arglead) end,
    desc = 'CallCanvas: one canvas for the changes of a commit or the workbench (no argument: pick from a list)',
  })

  vim.api.nvim_create_user_command('CallCanvasInstallHook', function(cmd)
    M.install_hook(cmd.bang)
  end, { bang = true, desc = 'CallCanvas: add the Claude Code hooks for live change sets (! removes them)' })
  vim.api.nvim_create_user_command('CallCanvasInstallSkill', function(cmd)
    M.install_skill(cmd.args)
  end, {
    nargs = '?',
    complete = 'dir',
    desc = 'CallCanvas: install the Claude Code skill that lets an AI comment on canvases (default: ~/.claude/skills)',
  })

  vim.api.nvim_create_user_command('CallCanvasStatus', function()
    M.status()
  end, { desc = 'CallCanvas: show host status' })

  return M
end

return M
