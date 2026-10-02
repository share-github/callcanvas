-- CallCanvas for LazyVim
--
-- Copy (or symlink) this file to ~/.config/nvim/lua/plugins/callcanvas.lua
--
--   ln -s /workspace/callcanvas-nvim/lazyvim/callcanvas.lua \
--         ~/.config/nvim/lua/plugins/callcanvas.lua
--
-- Keys live under <leader>v ("view"): LazyVim already owns the whole <leader>c
-- ("code") space — <leader>cc is Run Codelens — so a separate prefix avoids
-- fighting the LSP keymaps.

return {
  {
    'callcanvas-nvim',
    -- Local plugin: point this at your checkout.
    dir = vim.fn.expand('/workspace/callcanvas-nvim'),
    -- The lua module is `callcanvas`, not `callcanvas-nvim`, so name it for lazy.nvim.
    main = 'callcanvas',
    cmd = {
      'CallCanvas', 'CallCanvasBrowse', 'CallCanvasUrl',
      'CallCanvasList', 'CallCanvasStatus', 'CallCanvasStop',
      'CallCanvasBuildIndex', 'CallCanvasChangeSet', 'CallCanvasInstallSkill',
    },
    keys = {
      { '<leader>vv', '<cmd>CallCanvas<cr>', desc = 'CallCanvas: analyze at cursor' },
      { '<leader>vb', '<cmd>CallCanvasBrowse<cr>', desc = 'CallCanvas: open viewer' },
      { '<leader>vu', '<cmd>CallCanvasUrl<cr>', desc = 'CallCanvas: copy viewer URL' },
      { '<leader>vl', '<cmd>CallCanvasList<cr>', desc = 'CallCanvas: list open canvases' },
      { '<leader>vs', '<cmd>CallCanvasStatus<cr>', desc = 'CallCanvas: host status' },
      -- Java only: builds the call index up front so the first analysis is not slow.
      { '<leader>vi', '<cmd>CallCanvasBuildIndex<cr>', desc = 'CallCanvas: build call index (Java)' },
      -- The changes of a commit (or of the workbench) as one canvas: pick from a list —
      -- the workbench, then the recent commits ("直前のコミット" first).
      { '<leader>vc', '<cmd>CallCanvasChangeSet<cr>', desc = 'CallCanvas: change set (pick a commit / workbench)' },
      { '<leader>vq', '<cmd>CallCanvasStop<cr>', desc = 'CallCanvas: stop host' },
    },
    opts = {
      -- Neovim runs in the devcontainer while the browser runs on the host, so
      -- bind to all interfaces on a port that docker publishes to the host
      -- (.devcontainer/docker-compose.yml: "7333:7333").
      -- 5500 is deliberately avoided: that is Live Server's default port and is
      -- often already taken on the host, which shows up as "Cannot GET /k/..."
      -- from that other server.
      -- Running Neovim and the browser on the same machine? Drop both lines.
      host = '0.0.0.0',
      port = 7333,

      -- Seconds to keep the host alive after the last browser tab closes (0 = forever).
      idle_timeout = 300,

      -- Keep a line in the bottom right while the host is busy — including the call
      -- index build an analysis starts in the background, which outlives the analysis.
      -- Set to false to keep the screen quiet.
      progress = true,

      -- The browser is self-contained: a double-click on a window title shows the
      -- file in a side panel there, and Neovim is left alone. Set
      -- ['callcanvas.nvimJump'] = true in `settings` below if you want the browser to
      -- move Neovim as well — it rearranges windows in an editor you are not looking
      -- at, so it is off by default.
      --
      -- Only used when that is on:
      jump_mode = 'split',   -- 'split' (one reused window) | 'here' | 'tab'
      jump_focus = 'auto',   -- 'auto' (only when Neovim has focus) | true | false

      -- Settings normally come from `.vscode/settings.json` (the project's, or any
      -- ancestor up to the repo root) — the same file the VSIX reads, so
      -- `callcanvas.jumpToCallTargetKey`, depths and widths are configured once for
      -- both. Anything listed here would OVERRIDE that file, so keep it empty
      -- unless you want a Neovim-only value.
      --
      -- Note: the browser takes F12 for devtools, so if `.vscode/settings.json`
      -- leaves `callcanvas.jumpToCallTargetKey` at its default, set it to something
      -- like "shift+b" there.
      settings = {
        -- ['callcanvas.nvimJump'] = true,   -- let the browser jump in Neovim too
        -- ['callcanvas.windowWidth'] = 700,
      },
    },
  },

  -- which-key label for the new group (LazyVim ships which-key v3).
  {
    'folke/which-key.nvim',
    optional = true,
    opts = {
      spec = {
        { '<leader>v', group = 'view/callcanvas' },
      },
    },
  },
}
