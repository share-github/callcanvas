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
    },
    keys = {
      { '<leader>vv', '<cmd>CallCanvas<cr>', desc = 'CallCanvas: analyze at cursor' },
      { '<leader>vb', '<cmd>CallCanvasBrowse<cr>', desc = 'CallCanvas: open viewer' },
      { '<leader>vu', '<cmd>CallCanvasUrl<cr>', desc = 'CallCanvas: copy viewer URL' },
      { '<leader>vl', '<cmd>CallCanvasList<cr>', desc = 'CallCanvas: list open canvases' },
      { '<leader>vs', '<cmd>CallCanvasStatus<cr>', desc = 'CallCanvas: host status' },
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

      -- Where a jump from the browser lands: 'split' | 'here' | 'tab'
      jump_mode = 'split',

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
