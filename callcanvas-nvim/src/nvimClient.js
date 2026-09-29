'use strict';
/**
 * Talks back to the Neovim instance that launched us.
 *
 * Uses the nvim binary itself as the RPC client (`nvim --server <addr> --remote-expr`),
 * so there is no msgpack dependency and no extra tooling such as neovim-remote.
 */
const { spawn } = require('child_process');

/** Escape a string for embedding in a VimL single-quoted literal. */
function vimStr(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

class NvimClient {
    /**
     * @param {string|null} address `--server` address (v:servername of the caller)
     * @param {(msg: string) => void} log
     */
    constructor(address, log = () => {}) {
        this.address = address || null;
        this.log = log;
        this.nvimBin = process.env.CALLCANVAS_NVIM_BIN || 'nvim';
    }

    get available() {
        return !!this.address;
    }

    setAddress(address) {
        if (address && address !== this.address) {
            this.log(`nvim address updated: ${address}`);
            this.address = address;
        }
    }

    /** Run `nvim --server <addr> <args...>` and resolve with stdout. */
    run(args) {
        return new Promise((resolve) => {
            if (!this.address) {
                resolve({ ok: false, error: 'no nvim server address' });
                return;
            }
            const child = spawn(this.nvimBin, ['--server', this.address, ...args], {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', d => { stdout += d.toString(); });
            child.stderr.on('data', d => { stderr += d.toString(); });
            child.on('error', err => resolve({ ok: false, error: err.message }));
            child.on('close', code => {
                if (code === 0) {
                    resolve({ ok: true, stdout: stdout.trim() });
                } else {
                    resolve({ ok: false, error: (stderr || `exit ${code}`).trim() });
                }
            });
        });
    }

    /**
     * Open `file` in the launching Neovim and place the cursor on `line` (1-based).
     * Prefers the plugin's own jump function so the plugin decides window placement;
     * falls back to a plain `:edit +line` keystroke when the plugin is absent.
     */
    async jump(file, line) {
        const lineNr = Math.max(1, Number(line) || 1);
        if (!this.address) {
            const error = 'no Neovim address — run :CallCanvas once from the Neovim you want to jump in';
            this.log(`nvim jump skipped: ${error}`);
            return { ok: false, error };
        }
        const expr = `CallCanvasNvimJump(${vimStr(file)}, ${lineNr})`;
        let result = await this.run(['--remote-expr', expr]);
        if (!result.ok) {
            this.log(`remote-expr jump failed (${result.error}) — falling back to remote-send`);
            const keys = `<C-\\><C-N>:edit +${lineNr} ${String(file).replace(/ /g, '\\ ')}<CR>`;
            result = await this.run(['--remote-send', keys]);
        }
        if (!result.ok) {
            this.log(`nvim jump failed: ${result.error}`);
            return { ok: false, error: result.error };
        }
        return { ok: true };
    }

    /** Show a message in the launching Neovim (used for host-side notifications). */
    async notify(text, level = 'info') {
        const expr = `CallCanvasNvimNotify(${vimStr(text)}, ${vimStr(level)})`;
        const result = await this.run(['--remote-expr', expr]);
        return result.ok;
    }

    /**
     * Ask the user for a value inside Neovim. `--remote-expr` is synchronous, so
     * `input()` on the remote side blocks until the user answers.
     * @returns {Promise<string|null>}
     */
    async input(prompt, defaultValue = '') {
        const expr = `CallCanvasNvimInput(${vimStr(prompt)}, ${vimStr(defaultValue)})`;
        const result = await this.run(['--remote-expr', expr]);
        if (!result.ok) {
            return null;
        }
        const value = result.stdout;
        return value.length > 0 ? value : null;
    }

    /**
     * Ask the launching Neovim to choose from a list (a QuickPick in VS Code terms).
     * @returns {Promise<number>} 0-based choice, -1 when nobody could be asked
     *   (no address, no UI, plugin missing), -2 when the user cancelled.
     */
    async select(prompt, items) {
        if (!this.address) {
            return -1;
        }
        const list = (items || []).map(item => vimStr(item)).join(', ');
        const expr = `CallCanvasNvimSelect(${vimStr(prompt || 'Select')}, [${list}])`;
        const result = await this.run(['--remote-expr', expr]);
        if (!result.ok) {
            this.log(`nvim select failed: ${result.error}`);
            return -1;
        }
        const value = parseInt(result.stdout, 10);
        return Number.isNaN(value) ? -1 : value;
    }
}

module.exports = { NvimClient, vimStr };
