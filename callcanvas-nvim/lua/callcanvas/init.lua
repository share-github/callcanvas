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
  jump_win = nil }

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
local function open_url(url, attached)
  -- The link always points at the canvas that was just analysed, so pasting it in
  -- a NEW tab gives a second canvas side by side instead of moving the tab that
  -- follows the newest one.
  local shown = state.short_url or url
  if attached then
    local copied = M.config.copy_url and clipboard_copy(shown)
    local lines = { 'updated — your open tab reloaded itself' }
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
    notify('opened in the browser')
    return
  end
  if vim.env.BROWSER and vim.env.BROWSER ~= '' then
    vim.system({ vim.env.BROWSER, shown }, { detach = true })
    notify('opened in the browser')
    return
  end

  local handle, err = vim.ui.open(shown)
  if handle then
    notify('opened in the browser')
  else
    notify((err or 'could not open a browser') .. '\n' .. shown, vim.log.levels.WARN)
  end
end

--- Build the argument list for `callcanvas open`.
local function open_args(file, line)
  local args = {
    M.config.node, cli_path(), 'open',
    '--file', file,
    '--line', tostring(line),
    '--nvim', vim.v.servername,
    '--json',
  }
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

  vim.system(open_args(file, line), { text = true }, function(result)
    vim.schedule(function()
      if result.code ~= 0 then
        local err = (result.stderr or ''):gsub('%s+$', '')
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
      open_url(url, attached)
    end)
  end)
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

  vim.api.nvim_create_user_command('CallCanvasStatus', function()
    M.status()
  end, { desc = 'CallCanvas: show host status' })

  return M
end

return M
