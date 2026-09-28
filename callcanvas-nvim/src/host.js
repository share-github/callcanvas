'use strict';
/**
 * Wires everything together: extension host (shim) + HTTP/SSE server + Neovim client.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const { ConfigStore } = require('./config');
const { NvimClient } = require('./nvimClient');
const { ViewerServer } = require('./server');
const { createVscodeShim } = require('./vscodeShim');
const { languageIdFor } = require('./types');
const { resolveExtensionDirs, activateExtensions } = require('./extensionHost');

/** Entry command per language, as registered by the language extensions. */
const OPEN_COMMANDS = {
    java: 'javaCallHierarchy.openCallCanvasViewer',
    javascript: 'jsCallHierarchy.openCallCanvasViewer',
    javascriptreact: 'jsCallHierarchy.openCallCanvasViewer',
    typescript: 'tsCallHierarchy.openCallCanvasViewer',
    typescriptreact: 'tsCallHierarchy.openCallCanvasViewer',
    html: 'jsCallHierarchy.exportIncludeMap',
    jsp: 'jsCallHierarchy.exportIncludeMap'
};

const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'pom.xml', 'settings.gradle', 'settings.gradle.kts', 'package.json'];

/** Session lock files live outside the project so they never pollute the repo. */
function sessionDir() {
    const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
    return path.join(base, 'callcanvas-nvim');
}

function sessionKey(projectRoot) {
    return crypto.createHash('sha1').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
}

function sessionFile(projectRoot) {
    return path.join(sessionDir(), `${sessionKey(projectRoot)}.json`);
}

/**
 * The token is persisted per project so the viewer URL never changes: open it
 * once in the browser, bookmark it, and every later `:CallCanvas` reuses the
 * same tab (the page reloads itself) — no URL copying.
 *
 * It lives in the project's (gitignored) `.callcanvas-cache/` rather than the
 * runtime dir, because a devcontainer rebuild wipes /tmp — and a new token would
 * invalidate the cookie behind the bookmark.
 */
function persistentToken(projectRoot) {
    const projectFile = path.join(path.resolve(projectRoot), '.callcanvas-cache', 'nvim-token');
    const runtimeFile = path.join(sessionDir(), `${sessionKey(projectRoot)}.token`);

    const read = (file) => {
        try {
            const value = fs.readFileSync(file, 'utf8').trim();
            return /^[0-9a-f]{32,}$/.test(value) ? value : null;
        } catch {
            return null;
        }
    };

    // Reuse whatever is already there, preferring the durable location. A token
    // left in the runtime dir by an older version is adopted so the bookmark
    // people already made keeps working.
    const token = read(projectFile) || read(runtimeFile) || crypto.randomBytes(24).toString('hex');

    for (const file of [projectFile, runtimeFile]) {
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, token + '\n', { mode: 0o600 });
            break;
        } catch { /* try the next location, else a per-run token */ }
    }
    return token;
}

/**
 * Pick the workspace root the extensions should see.
 *
 * The nearest build file wins over the repository root: in a monorepo that keeps
 * the analysis (and `workspace.findFiles`) inside the project being analysed,
 * and the extensions expand it to the multi-module root by themselves when
 * needed. `--root` overrides this.
 */
function detectProjectRoot(startFile) {
    const resolved = path.resolve(startFile);
    let dir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
        ? resolved
        : path.dirname(resolved);
    let gitRoot = null;
    while (true) {
        if (BUILD_FILES.some(f => fs.existsSync(path.join(dir, f)))) {
            return dir;
        }
        if (!gitRoot && fs.existsSync(path.join(dir, '.git'))) {
            gitRoot = dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return gitRoot || path.dirname(resolved);
}

/** The viewer HTML carries the canvas JSON path — use it as the canvas identity. */
function extractJsonPath(html) {
    const match = String(html).match(/jsonFilePath: "((?:[^"\\]|\\.)*)"/);
    if (!match) {
        return null;
    }
    try {
        return JSON.parse(`"${match[1]}"`);
    } catch {
        return match[1];
    }
}

/** Stable, short canvas id derived from the JSON path (keeps permalinks valid). */
function canvasIdFor(jsonPath) {
    return crypto.createHash('sha1').update(String(jsonPath)).digest('hex').slice(0, 10);
}

class CallCanvasHost {
    /**
     * @param {object} options
     * @param {string} options.projectRoot
     * @param {string|null} options.nvimAddress
     * @param {string} options.bindHost
     * @param {number} options.port
     * @param {number} options.idleTimeoutMs 0 disables the idle shutdown
     * @param {object} options.settings      flat config overrides
     * @param {boolean} options.verbose
     */
    constructor(options) {
        this.projectRoot = path.resolve(options.projectRoot);
        this.verbose = !!options.verbose;
        this.idleTimeoutMs = options.idleTimeoutMs === undefined ? 5 * 60 * 1000 : options.idleTimeoutMs;
        this.idleTimer = null;
        this.hadClient = false;
        /** canvas id -> panel (several canvases can be open at once) */
        this.panels = new Map();
        /** panel -> canvas id */
        this.panelIds = new Map();
        this.latestPanel = null;
        this.panelGeneration = 0;
        this.lastError = null;
        this.uiRequests = new Map();
        this.uiSequence = 0;
        this.activeCanvasId = null;

        this.log = (message) => {
            if (this.verbose) {
                process.stderr.write(`[callcanvas] ${message}\n`);
            }
        };

        this.extensionDirs = resolveExtensionDirs();
        this.config = new ConfigStore(Object.values(this.extensionDirs), this.projectRoot, options.settings || {});
        this.nvim = new NvimClient(options.nvimAddress, this.log);

        this.server = new ViewerServer({
            host: options.bindHost,
            port: options.port,
            token: options.auth === false ? undefined : persistentToken(this.projectRoot),
            auth: options.auth,
            bridgeSettings: {
                // The VSIX binds jump-back to alt+left through VS Code's keybinding
                // layer, which does not exist in a browser — and alt+left is the
                // browser's own Back. The bridge binds these instead.
                jumpBackKey: this.config.lookup('callcanvas.jumpBackKey', 'shift+o'),
                // What a double-click on a window title does in the browser:
                // 'both' (default) = jump in Neovim AND show the file in a side panel,
                // 'nvim' = jump only, 'panel' = side panel only.
                openFileMode: this.config.lookup('callcanvas.openFileMode', 'both'),
                // Also answer alt+left (and cmd/ctrl+[) with jump-back instead of
                // letting the browser navigate away from the canvas.
                interceptBrowserBack: this.config.lookup('callcanvas.interceptBrowserBack', true) !== false
            },
            assetRoots: Object.values(this.extensionDirs),
            fileRoot: this.projectRoot,
            log: this.log,
            handlers: {
                onMessage: (message, canvasId) => this.onBrowserMessage(message, canvasId),
                onUiReply: (id, value) => this.onUiReply(id, value),
                onOpen: (body) => this.open(body),
                onClientCount: (count) => this.onClientCount(count),
                onShutdown: () => this.shutdown()
            }
        });

        this.shim = createVscodeShim({
            projectRoot: this.projectRoot,
            config: this.config,
            nvim: this.nvim,
            log: this.log,
            extensionPaths: this.extensionDirs,
            ui: this.buildUi(),
            panelSink: this.buildPanelSink()
        });
    }

    async start() {
        const running = await this.findRunningSession();
        if (running) {
            throw new Error(
                `a CallCanvas host is already running for ${this.projectRoot} `
                + `(pid ${running.pid}, ${running.url}) — use it, or stop it first`
            );
        }
        const listening = await this.server.listen();
        const activation = activateExtensions(this.shim, this.extensionDirs, this.log);
        if (activation.activated.length === 0) {
            throw new Error('no CallCanvas extension could be activated — run `npm run compile` in the extension directories');
        }
        this.activation = activation;
        this.writeSession(listening);
        this.log(`project root: ${this.projectRoot}`);
        return listening;
    }

    /**
     * A second host for the same project would overwrite the first one's session
     * file and orphan it (the old process keeps holding its port), so refuse
     * instead. Returns the live session, or null.
     */
    findRunningSession() {
        let session;
        try {
            session = JSON.parse(fs.readFileSync(sessionFile(this.projectRoot), 'utf8'));
        } catch {
            return Promise.resolve(null);
        }
        if (!session || typeof session.pid !== 'number' || session.pid === process.pid) {
            return Promise.resolve(null);
        }
        try {
            process.kill(session.pid, 0);
        } catch {
            return Promise.resolve(null);
        }
        return new Promise((resolve) => {
            const host = session.host === '0.0.0.0' ? '127.0.0.1' : session.host;
            const req = http.get({ host, port: session.port, path: '/api/ping', timeout: 2000 }, (res) => {
                res.resume();
                resolve(res.statusCode === 200 ? session : null);
            });
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.on('error', () => resolve(null));
        });
    }

    writeSession(listening) {
        fs.mkdirSync(sessionDir(), { recursive: true });
        this.sessionPath = sessionFile(this.projectRoot);
        fs.writeFileSync(this.sessionPath, JSON.stringify({
            pid: process.pid,
            projectRoot: this.projectRoot,
            host: listening.host,
            port: listening.port,
            token: listening.token,
            url: this.server.url,
            bookmarkUrl: this.server.bookmarkUrl,
            startedAt: new Date().toISOString()
        }, null, 2));
    }

    clearSession() {
        try {
            if (this.sessionPath && fs.existsSync(this.sessionPath)) {
                const current = JSON.parse(fs.readFileSync(this.sessionPath, 'utf8'));
                if (current.pid === process.pid) {
                    fs.unlinkSync(this.sessionPath);
                }
            }
        } catch { /* best effort */ }
    }

    get url() {
        return this.server.url;
    }

    // --- open flow ---------------------------------------------------------
    /**
     * Analyze from a caret position and show the result.
     * @param {{file: string, line?: number, nvim?: string, json?: boolean}} request
     */
    async open(request) {
        const file = path.resolve(request.file);
        if (!fs.existsSync(file)) {
            return { ok: false, error: `file not found: ${file}` };
        }
        if (request.nvim) {
            this.nvim.setAddress(request.nvim);
        }
        const line = Math.max(1, Number(request.line) || 1);
        this.shim.setActiveEditor(file, line);

        const languageId = languageIdFor(file);
        this.log(`open ${file}:${line} (${languageId})`);

        const generationBefore = this.panelGeneration;
        this.lastError = null;

        try {
            // Explicit command form (`callcanvas command <id>`)
            if (request.command) {
                const value = await this.runCommand(request.command, request.args, null);
                return { ok: true, value: value === undefined ? null : value, url: this.url };
            }
            if (file.endsWith('.json')) {
                await this.shim.vscode.commands.executeCommand(
                    'callcanvas.openViewerWithFile',
                    this.shim.vscode.Uri.file(file)
                );
                return this.openResult(generationBefore);
            }
            const command = OPEN_COMMANDS[languageId];
            if (!command) {
                return { ok: false, error: `unsupported file type: ${path.basename(file)}` };
            }
            await this.shim.vscode.commands.executeCommand(command);
            return this.openResult(generationBefore);
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            this.log(`open failed: ${error && error.stack ? error.stack : message}`);
            return { ok: false, error: message };
        }
    }

    /**
     * The extensions report problems through `showErrorMessage` and return
     * normally, so "no new canvas was created" is how a failed analysis looks
     * from here. Turn that into an error instead of handing Neovim a URL that
     * would open an empty page.
     */
    openResult(generationBefore) {
        if (this.panelGeneration === generationBefore) {
            return { ok: false, error: this.lastError || 'analysis produced no canvas' };
        }
        const canvasId = this.latestPanel ? this.panelIds.get(this.latestPanel) : this.server.latestId;
        const entry = canvasId ? this.server.canvases.get(canvasId) : null;
        // `clients` lets the caller say "your open tab just reloaded" instead of
        // handing over a URL that does not need to be opened again.
        return {
            ok: true,
            url: this.url,
            // Short, stable, typable — what Neovim shows and copies. Points at THIS
            // canvas, so pasting it in a new tab opens a second canvas instead of
            // moving the tab that follows `/`.
            shortUrl: this.server.mintUnlockUrl(canvasId),
            shortBookmarkUrl: this.server.mintUnlockUrl(),
            bookmarkUrl: this.server.bookmarkUrl,
            permalink: canvasId ? this.server.permalink(canvasId) : this.url,
            canvasListUrl: this.server.canvasListUrl,
            canvasId: canvasId || null,
            title: entry ? entry.title : null,
            canvasCount: this.server.canvases.size,
            clients: canvasId ? this.server.clientsForCanvas(canvasId) : 0
        };
    }

    /** All canvases currently open (for `callcanvas status`). */
    canvasSummaries() {
        return this.server.canvasSummaries();
    }

    /** Run any registered extension command (used by `callcanvas command`). */
    async runCommand(commandId, args, context) {
        if (context && context.file) {
            this.shim.setActiveEditor(path.resolve(context.file), context.line || 1);
        }
        if (context && context.nvim) {
            this.nvim.setAddress(context.nvim);
        }
        return this.shim.vscode.commands.executeCommand(commandId, ...(args || []));
    }

    // --- webview plumbing --------------------------------------------------
    buildPanelSink() {
        return {
            onCreate: (panel) => {
                // Do NOT dispose the previous panel: multiple canvases coexist,
                // exactly like multiple viewer tabs in VS Code. A canvas is
                // identified by its JSON path (see onHtml), which is only known
                // once the HTML arrives.
                this.panelGeneration++;
                this.latestPanel = panel;
            },
            onHtml: (panel, html) => {
                const jsonPath = extractJsonPath(html);
                const id = jsonPath ? canvasIdFor(jsonPath) : this.server.anonId;

                const previous = this.panels.get(id);
                if (previous && previous !== panel) {
                    // Same canvas JSON re-analysed: the old panel is replaced, but
                    // the canvas id (and therefore any pinned tab) stays valid.
                    this.log(`canvas ${id} re-analysed — replacing its panel`);
                    this.panelIds.delete(previous);
                    previous.dispose();
                }
                this.panels.set(id, panel);
                this.panelIds.set(panel, id);
                this.latestPanel = panel;

                this.server.setCanvas(id, html, {
                    title: panel.title,
                    jsonPath: jsonPath || ''
                });
            },
            onPost: (panel, message) => {
                const id = this.panelIds.get(panel);
                if (id) {
                    this.server.broadcastTo(id, { kind: 'post', message });
                }
            },
            onTitle: (panel, title) => {
                const id = this.panelIds.get(panel);
                if (id) {
                    const entry = this.server.canvases.get(id);
                    if (entry) {
                        entry.title = title;
                    }
                    this.server.broadcastTo(id, { kind: 'title', title });
                }
            },
            onDispose: (panel) => {
                const id = this.panelIds.get(panel);
                this.panelIds.delete(panel);
                if (id && this.panels.get(id) === panel) {
                    this.panels.delete(id);
                    this.server.dropCanvas(id);
                }
                if (this.latestPanel === panel) {
                    this.latestPanel = null;
                }
            },
            onReveal: () => {},
            assetUrl: (fsPath) => this.server.assetUrl(fsPath)
        };
    }

    onBrowserMessage(message, canvasId) {
        const panel = (canvasId && this.panels.get(canvasId)) || this.latestPanel;
        if (!panel) {
            this.log(`message from browser but canvas ${canvasId} is not open`);
            return;
        }
        // Dialogs and toasts raised while handling this message belong to the tab
        // that sent it.
        this.activeCanvasId = canvasId || this.panelIds.get(panel) || null;
        panel._receive(message);
    }

    /** Where host-level UI (toasts, progress, dialogs) should be shown. */
    uiTargetCanvas() {
        if (this.activeCanvasId && this.server.canvases.has(this.activeCanvasId)) {
            return this.activeCanvasId;
        }
        return this.server.latestId;
    }

    sendToUi(payload) {
        const canvasId = this.uiTargetCanvas();
        if (canvasId) {
            this.server.broadcastTo(canvasId, payload);
        } else {
            this.server.broadcastAll(payload);
        }
    }

    // --- dialogs -----------------------------------------------------------
    buildUi() {
        const host = this;
        return {
            progress(text, active) {
                host.sendToUi({ kind: 'progress', text, active });
            },

            async message(level, message, items) {
                host.log(`${level}: ${message}`);
                if (level === 'error') {
                    host.lastError = String(message);
                }
                if (!items || items.length === 0) {
                    if (host.server.clients.size === 0 && host.nvim.available) {
                        // No browser yet (e.g. during the first analysis) — the
                        // message would otherwise only reach the log file.
                        host.nvim.notify(String(message), level);
                    } else {
                        host.sendToUi({ kind: 'toast', level, text: String(message) });
                    }
                    return undefined;
                }
                const labels = items.map(item => (typeof item === 'string' ? item : item.title || String(item)));
                const index = await host.requestUi('message', { message: String(message), items: labels });
                return typeof index === 'number' ? items[index] : undefined;
            },

            async input(options) {
                let error = null;
                for (let attempt = 0; attempt < 3; attempt++) {
                    const value = await host.requestUi('input', {
                        prompt: options.prompt || options.title || 'Input',
                        placeHolder: options.placeHolder || '',
                        value: options.value || '',
                        error
                    }, () => options.value || null);
                    if (value === null || value === undefined) {
                        return undefined;
                    }
                    if (typeof options.validateInput === 'function') {
                        const problem = await options.validateInput(value);
                        if (problem) {
                            error = typeof problem === 'string' ? problem : problem.message;
                            continue;
                        }
                    }
                    return value;
                }
                return undefined;
            },

            async pick(items, options) {
                const list = (items || []).map(item => (
                    typeof item === 'string'
                        ? { label: item, description: '' }
                        : { label: item.label, description: item.description || '' }
                ));
                if (list.length === 0) {
                    return undefined;
                }
                const index = await host.requestUi(
                    'pick',
                    { items: list, placeHolder: options.placeHolder || options.title || 'Select' },
                    () => 0
                );
                return typeof index === 'number' ? items[index] : undefined;
            },

            async openPath(options) {
                const defaultPath = options.defaultUri ? options.defaultUri.fsPath : '';
                return host.requestUi('openPath', {
                    title: options.title || 'Path to open',
                    defaultPath
                }, () => null);
            },

            async savePath(options) {
                const defaultPath = options.defaultUri ? options.defaultUri.fsPath : '';
                return host.requestUi('savePath', {
                    title: options.title || 'Save as',
                    defaultPath
                }, () => defaultPath || null);
            }
        };
    }

    /**
     * Ask the user something. The browser answers when one is attached; otherwise
     * Neovim is asked (its `input()` blocks the remote call until answered), and
     * `headlessFallback` decides what happens when neither can answer.
     */
    async requestUi(type, payload, headlessFallback) {
        if (this.server.clients.size > 0) {
            const id = `ui-${++this.uiSequence}`;
            return new Promise((resolve) => {
                const timer = setTimeout(() => {
                    if (this.uiRequests.delete(id)) {
                        this.log(`ui request ${id} timed out`);
                        resolve(null);
                    }
                }, 5 * 60 * 1000);
                this.uiRequests.set(id, (value) => {
                    clearTimeout(timer);
                    resolve(value);
                });
                this.sendToUi({ kind: 'ui', id, type, payload });
            });
        }

        if (this.nvim.available && (type === 'input' || type === 'openPath' || type === 'savePath')) {
            const prompt = type === 'input'
                ? `${payload.prompt}${payload.error ? ` [${payload.error}]` : ''}: `
                : `${payload.title}: `;
            const answer = await this.nvim.input(prompt, payload.value || payload.defaultPath || '');
            if (answer !== null) {
                return answer;
            }
        }

        const fallback = headlessFallback ? headlessFallback() : null;
        this.log(`ui request '${type}' answered headlessly with ${JSON.stringify(fallback)}`);
        return fallback;
    }

    onUiReply(id, value) {
        const resolve = this.uiRequests.get(id);
        if (resolve) {
            this.uiRequests.delete(id);
            resolve(value);
        }
    }

    // --- lifecycle ---------------------------------------------------------
    onClientCount(count) {
        if (count > 0) {
            this.hadClient = true;
            if (this.idleTimer) {
                clearTimeout(this.idleTimer);
                this.idleTimer = null;
            }
            return;
        }
        if (!this.hadClient || !this.idleTimeoutMs) {
            return;
        }
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
        }
        this.idleTimer = setTimeout(() => {
            this.log('no browser attached — shutting down (idle)');
            this.shutdown();
        }, this.idleTimeoutMs);
    }

    async shutdown() {
        this.clearSession();
        await this.server.close();
        process.exit(0);
    }
}

module.exports = {
    CallCanvasHost, detectProjectRoot, sessionFile, sessionDir, persistentToken,
    extractJsonPath, canvasIdFor, OPEN_COMMANDS
};
