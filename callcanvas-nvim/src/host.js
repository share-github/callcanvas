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

const NVIM_WATCH_INTERVAL_MS = 1000;

/** @param {number} pid */
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: the process exists but belongs to someone else.
        return error.code === 'EPERM';
    }
}
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

/** The viewer command that builds a change set canvas (commit / workbench / live). */
const CHANGE_SET_COMMAND = 'callcanvas.openChangeSet';

/** The Java extension prefixes every automatic (background) index build line with this. */
const AUTO_INDEX_PREFIX = '[Auto-Index]';

const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'pom.xml', 'settings.gradle', 'settings.gradle.kts', 'package.json'];
/** A Java module is a directory with a Java build file — package.json does not count. */
const JAVA_BUILD_FILES = ['pom.xml', 'build.gradle', 'build.gradle.kts'];

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

/** Does this directory declare itself the root of a multi-module build? */
function isAggregatorDir(dir) {
    for (const name of ['settings.gradle', 'settings.gradle.kts']) {
        try {
            if (fs.readFileSync(path.join(dir, name), 'utf8').includes('include')) {
                return true;
            }
        } catch { /* not there */ }
    }
    try {
        // '<modules>' only: '<artifactId>module-core</artifactId>' is not an aggregator.
        return fs.readFileSync(path.join(dir, 'pom.xml'), 'utf8').includes('<modules>');
    } catch {
        return false;
    }
}

/**
 * Every module directory an aggregator declares, following nested <modules> and
 * ':a:b' includes (same rules as the Java extension's moduleDiscovery.ts).
 */
function declaredModuleDirs(root) {
    const dirs = new Set();
    for (const name of ['settings.gradle', 'settings.gradle.kts']) {
        let text;
        try {
            text = fs.readFileSync(path.join(root, name), 'utf8');
        } catch {
            continue;
        }
        text = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        for (const match of text.matchAll(/\binclude\s*(\(([^)]*)\)|([^\n]*))/g)) {
            for (const quoted of (match[2] ?? match[3] ?? '').matchAll(/['"]([^'"]+)['"]/g)) {
                const segments = quoted[1].split(':').filter(Boolean);
                for (let i = 1; i <= segments.length; i++) {
                    dirs.add(path.resolve(root, ...segments.slice(0, i)));
                }
            }
        }
    }
    const walk = (dir) => {
        let text;
        try {
            text = fs.readFileSync(path.join(dir, 'pom.xml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
        } catch {
            return;
        }
        for (const match of text.matchAll(/<module>([^<]+)<\/module>/g)) {
            let child = path.resolve(dir, match[1].trim());
            if (/\.xml$/i.test(child)) {
                child = path.dirname(child);
            }
            if (!dirs.has(child) && child !== path.resolve(root)) {
                dirs.add(child);
                walk(child);
            }
        }
    };
    walk(root);
    return dirs;
}

/**
 * Widen an aggregator to the outermost one that (transitively) declares it, up to
 * `ceiling`. A submodule of ruoyi-modules must reach the top pom, or ruoyi-common and
 * ruoyi-admin fall outside the workspace the extension is given.
 */
function outermostAggregator(dir, ceiling) {
    let result = dir;
    let current = dir;
    while (current !== ceiling) {
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
        if (isAggregatorDir(current) && declaredModuleDirs(current).has(path.resolve(result))) {
            result = current;
        }
    }
    return result;
}

/** The text of a directory's Java build files, for spotting dependencies by name. */
function buildFileText(dir) {
    let text = '';
    for (const name of JAVA_BUILD_FILES) {
        try {
            text += fs.readFileSync(path.join(dir, name), 'utf8');
        } catch { /* not there */ }
    }
    return text;
}

/** Java modules beside `exclude` under `parent`. */
function siblingModules(parent, exclude) {
    let entries;
    try {
        entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(parent, entry.name))
        .filter(sibling => sibling !== exclude
            && JAVA_BUILD_FILES.some(f => fs.existsSync(path.join(sibling, f)))
            && fs.existsSync(path.join(sibling, 'src', 'main', 'java')));
}

/** Is `name` mentioned as a whole name? "sample-app" must not match "sample-app-animal". */
function namesModule(text, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`).test(text);
}

/**
 * Do `module` and a sibling name each other in their build files?
 *
 * Without an aggregator file that dependency is the only thing that tells modules of
 * one build (sample-cross-module-app: module-front depends on module-core) from
 * unrelated projects that merely share a parent directory (sample-project/*, where
 * widening would pull every sample app into one analysis).
 */
function modulesReferenceEachOther(parent, module) {
    const siblings = siblingModules(parent, module);
    if (siblings.length === 0) {
        return false;
    }
    const ownText = buildFileText(module);
    const ownName = path.basename(module);
    return siblings.some(sibling => namesModule(ownText, path.basename(sibling))
        || namesModule(buildFileText(sibling), ownName));
}

/**
 * Climb from a module to the root of its multi-module build, mirroring the Java
 * extension's own rules (an aggregator file, or modules side by side).
 *
 * This has to happen here: the extension only walks up as far as the workspace
 * folder it is given, so handing it a submodule hides every other module —
 * cross-module calls then resolve to nothing.
 */
function findMultiModuleRoot(module, gitRoot) {
    // Only Java builds have modules. A package.json project must not be widened into
    // the directory that happens to hold it (sample-project/sample-nextjs).
    if (!JAVA_BUILD_FILES.some(f => fs.existsSync(path.join(module, f)))) {
        return null;
    }
    const ceiling = gitRoot && module.startsWith(gitRoot) ? gitRoot : path.dirname(module);
    let dir = module;
    while (true) {
        if (isAggregatorDir(dir)) {
            return outermostAggregator(dir, ceiling);
        }
        const parent = path.dirname(dir);
        if (dir === ceiling || parent === dir) {
            break;
        }
        dir = parent;
    }
    // No aggregator file, just modules in one directory (sample-cross-module-app).
    // Never the repository root: that usually holds unrelated projects rather than
    // modules, and grouping them would analyse (and index) the whole repo.
    const parent = path.dirname(module);
    if (parent !== module && parent !== gitRoot && modulesReferenceEachOther(parent, module)) {
        return parent;
    }
    return null;
}

/**
 * Pick the workspace root the extensions should see.
 *
 * The nearest build file wins over the repository root: in a monorepo that keeps
 * the analysis (and `workspace.findFiles`) inside the project being analysed.
 * A submodule is widened to its multi-module root, because that is the boundary
 * the extension needs to see every module. `--root` overrides this.
 */
function detectProjectRoot(startFile) {
    const resolved = path.resolve(startFile);
    let dir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
        ? resolved
        : path.dirname(resolved);
    let nearest = null;
    let gitRoot = null;
    while (true) {
        if (!nearest && BUILD_FILES.some(f => fs.existsSync(path.join(dir, f)))) {
            nearest = dir;
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
    if (!nearest) {
        return gitRoot || path.dirname(resolved);
    }
    return findMultiModuleRoot(nearest, gitRoot) || nearest;
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

/**
 * What a change set canvas is about, read from its JSON (`metadata.changeSet`): a
 * commit (short hash + subject) or the workbench (uncommitted changes), and how many
 * files and islands it has. Only for display (the canvas title, the summary Neovim
 * shows); null for other canvases.
 */
function changeSetSummary(jsonPath) {
    let canvas;
    try {
        canvas = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch {
        return null;
    }
    const changeSet = canvas && canvas.metadata && canvas.metadata.changeSet;
    if (!changeSet || typeof changeSet !== 'object') {
        return null;
    }
    const summary = {
        kind: changeSet.kind === 'workbench' || changeSet.kind === 'live' ? changeSet.kind : 'commit',
        commit: null,
        subject: null,
        fileCount: Array.isArray(changeSet.files) ? changeSet.files.length : 0,
        islandCount: (canvas.groups || []).filter(group => group && group.kind === 'island').length
    };
    if (summary.kind === 'commit' && changeSet.commit) {
        summary.commit = String(changeSet.commit).slice(0, 7);
        try {
            const line = require('child_process').execFileSync(
                'git', ['log', '-1', '--no-color', '--format=%h%x09%s', String(changeSet.commit)],
                { cwd: path.dirname(jsonPath), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
            ).trim();
            const tab = line.indexOf('\t');
            if (tab > 0) {
                summary.commit = line.slice(0, tab);
                summary.subject = line.slice(tab + 1) || null;
            }
        } catch {
            // Not in this repository any more: the hash alone still names it.
        }
    }
    return summary;
}

/** One line per QuickPick item for Neovim's list: `label — description`. */
function quickPickLines(items) {
    return (items || []).map(item => (
        typeof item === 'string'
            ? item
            : (item.description ? `${item.label} — ${item.description}` : String(item.label))
    ));
}

/** The canvas title of a change set: `変更集合 <short hash> <subject>` / `変更集合 ワークベンチ` / `変更集合 ライブ`. */
function changeSetTitle(summary) {
    if (summary.kind === 'workbench') {
        return '変更集合 ワークベンチ';
    }
    if (summary.kind === 'live') {
        return '変更集合 ライブ';
    }
    return ['変更集合', summary.commit, summary.subject].filter(Boolean).join(' ');
}

/** `metadata.changeSet` of a canvas JSON, or null. */
function readChangeSet(jsonPath) {
    try {
        const canvas = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const changeSet = canvas && canvas.metadata && canvas.metadata.changeSet;
        return changeSet && typeof changeSet === 'object' ? changeSet : null;
    } catch {
        return null;
    }
}

/** Matches the hook command `callcanvas install-hook` writes (whatever node / checkout it pointed at). */
const NOTIFY_HOOK_PATTERN = /callcanvas[^\s"]*[\\/]src[\\/]cli\.js"?\s+notify\b/;

/** Claude Code's user settings file ($CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json). */
function claudeUserSettingsPath() {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return path.join(configDir, 'settings.json');
}

/**
 * The Claude Code settings files that have the `callcanvas notify` hook (PostToolUse): the
 * user settings, and `.claude/settings.json` / `.claude/settings.local.json` of the project
 * root or a directory above it (Claude Code may run at the repository root while Neovim opened
 * a sub-project). Empty when none has it — a live change set would then never be rebuilt.
 */
function notifyHookSettings(projectRoot) {
    const files = [claudeUserSettingsPath()];
    for (let dir = path.resolve(projectRoot); ; dir = path.dirname(dir)) {
        files.push(path.join(dir, '.claude', 'settings.json'), path.join(dir, '.claude', 'settings.local.json'));
        if (path.dirname(dir) === dir) {
            break;
        }
    }
    return [...new Set(files)].filter((file) => {
        let settings;
        try {
            settings = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            return false;
        }
        const groups = settings && settings.hooks && Array.isArray(settings.hooks.PostToolUse) ? settings.hooks.PostToolUse : [];
        return groups.some(group => group && Array.isArray(group.hooks)
            && group.hooks.some(h => h && typeof h.command === 'string' && NOTIFY_HOOK_PATTERN.test(h.command)));
    });
}

/** Where `callcanvas.refreshLiveChangeSet` writes a rebuilt live canvas until it is taken in. */
function livePendingPath(jsonPath) {
    return `${jsonPath}.pending`;
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
        /**
         * Commands in flight. `javaCallHierarchy.buildIndex` runs for minutes on a
         * real project, so the idle shutdown must not fire in the middle of one.
         */
        this.runningCommands = 0;
        // Neovim processes this host serves (pid -> true). When every one of them is
        // gone the host exits too: a host outliving its editor keeps holding the fixed
        // port, and the next project's :CallCanvas fails with EADDRINUSE.
        this.nvimPids = new Set();
        this.nvimWatch = null;
        /** Last progress line pushed to Neovim, so the same text is not re-sent. */
        this.lastProgressText = null;
        this.lastProgressAt = 0;
        /**
         * Work in flight. The line is on screen while this is > 0 — "shown while
         * something is actually running" — and several activities overlap (an analysis
         * whose withProgress nests inside it, and the index build it starts, which
         * outlives it), so the line must only be cleared by the last one.
         */
        this.workDepth = 0;
        /** canvas id -> panel (several canvases can be open at once) */
        this.panels = new Map();
        /** panel -> canvas id */
        this.panelIds = new Map();
        this.latestPanel = null;
        this.panelGeneration = 0;
        this.lastError = null;
        /** The last info toast — why a command that should open a canvas did not ("no changes"). */
        this.lastInfo = null;
        /** canvas id -> changeSetSummary() of a change set canvas (null for others) */
        this.changeSets = new Map();
        /**
         * canvas id -> live state of a live change set canvas (see registerLive). Rebuilt on
         * `callcanvas notify` (the Claude Code hook), one rebuild at a time per canvas; a
         * notification arriving during a rebuild asks for one more afterwards. The rebuild goes
         * to `<json>.pending` and is shown in the browser only when the person takes it in.
         */
        this.live = new Map();
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
                // Off by default: the browser is self-contained (a double-click shows
                // the file in its own panel). Driving Neovim from the browser means
                // rearranging windows in an editor nobody is looking at, which is how
                // people lose the place they were working in — opt in explicitly.
                nvimJump: this.config.lookup('callcanvas.nvimJump', false) === true,
                // ctrl+w closes the browser tab and cannot be intercepted, so the
                // canvas needs its own close key.
                closeKey: this.config.lookup('callcanvas.closeKey', 'shift+w'),
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
                onLiveNotify: () => this.notifyLive(),
                onLiveStatus: (canvasId) => this.liveStatus(canvasId),
                onLiveApply: (canvasId) => this.applyLive(canvasId),
                onLiveStart: (canvasId) => this.startLive(canvasId),
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
            onOutput: (channel, line) => this.onOutput(channel, line),
            panelSink: this.buildPanelSink(),
            nvimJumpEnabled: () => this.nvimJumpEnabled(),
            showFileInBrowser: (fsPath, line) => this.showFileInBrowser(fsPath, line)
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
        if (request.nvimPid) {
            this.watchNvim(Number(request.nvimPid));
        }
        const line = Math.max(1, Number(request.line) || 1);
        // A directory is a legitimate anchor for `callcanvas command` / `build-index`
        // run with no file (Neovim with no buffer open falls back to its cwd): the
        // project is then resolved from the workspace, not from a caret. Making an
        // editor out of it would only fail (EISDIR) before the command ever ran.
        const isDirectory = fs.statSync(file).isDirectory();
        if (isDirectory) {
            this.shim.clearActiveEditor();
        } else {
            this.shim.setActiveEditor(file, line);
        }

        const languageId = languageIdFor(file);
        this.log(`open ${file}:${line} (${isDirectory ? 'directory' : languageId})`);

        const generationBefore = this.panelGeneration;
        this.lastError = null;
        this.lastInfo = null;

        try {
            // Explicit command form (`callcanvas command <id>`)
            if (request.command) {
                const value = await this.runCommand(request.command, request.args, null);
                // The extensions report problems through `showErrorMessage` and return
                // normally (same as the analysis path, see openResult), so the toast is
                // the only sign the command did not do its job.
                if (this.lastError) {
                    return { ok: false, error: this.lastError, url: this.url };
                }
                const result = { ok: true, value: value === undefined ? null : value, url: this.url };
                // A command that opened a canvas (`callcanvas.openChangeSet`) answers like an
                // analysis does, so the caller gets the canvas's own URLs (/c/<id>, /k/…).
                if (this.panelGeneration !== generationBefore) {
                    return Object.assign(this.openResult(generationBefore), { value: result.value });
                }
                if (this.lastInfo) {
                    result.message = this.lastInfo;
                }
                return result;
            }
            if (file.endsWith('.json')) {
                await this.shim.vscode.commands.executeCommand(
                    'callcanvas.openViewerWithFile',
                    this.shim.vscode.Uri.file(file)
                );
                return this.openResult(generationBefore);
            }
            const command = isDirectory ? null : OPEN_COMMANDS[languageId];
            if (!command) {
                return {
                    ok: false,
                    error: isDirectory
                        ? `${file} is a directory — analysis needs a file and a line`
                        : `unsupported file type: ${path.basename(file)}`
                };
            }
            // Bracket the analysis itself, not just the extension's own withProgress:
            // only the Java extension reports progress, so a JS/TS analysis would
            // otherwise run with nothing on screen.
            this.beginWork(`analyzing ${path.basename(file)}:${line}`);
            try {
                await this.shim.vscode.commands.executeCommand(command);
            } finally {
                this.endWork();
            }
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
            // For a change set: kind / commit / subject / fileCount / islandCount, so Neovim can
            // say what it opened without reading the JSON.
            changeSet: (canvasId && this.liveAwareSummary(canvasId)) || null,
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
        this.runningCommands++;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        this.beginWork(`running ${commandId}`);
        try {
            return await this.shim.vscode.commands.executeCommand(commandId, ...(args || []));
        } finally {
            this.endWork();
            this.runningCommands--;
            if (this.server.clients.size === 0) {
                this.scheduleIdleShutdown();
            }
        }
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

                // A change set canvas is named after its range, not its first window
                // (display only — the JSON is not touched).
                const changeSet = jsonPath ? changeSetSummary(jsonPath) : null;
                this.changeSets.set(id, changeSet);

                this.server.setCanvas(id, html, {
                    title: changeSet ? changeSetTitle(changeSet) : panel.title,
                    jsonPath: jsonPath || ''
                });
                if (changeSet && changeSet.kind === 'live') {
                    this.registerLive(id, jsonPath);
                } else {
                    this.live.delete(id);
                }
            },
            onPost: (panel, message) => {
                const id = this.panelIds.get(panel);
                if (id) {
                    this.server.broadcastTo(id, { kind: 'post', message });
                }
            },
            onTitle: (panel, title) => {
                const id = this.panelIds.get(panel);
                if (id && this.changeSets.get(id)) {
                    return;                               // keeps its change set name
                }
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
                    this.changeSets.delete(id);
                    this.live.delete(id);
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

    // --- live change set ---------------------------------------------------
    /**
     * Start following a live change set canvas. A rebuild left over from an earlier host
     * (`<json>.pending`) is offered again; a refresh catches up with what changed meanwhile
     * (it does nothing when the working tree is the canvas's).
     */
    registerLive(id, jsonPath) {
        const existing = this.live.get(id);
        if (existing && existing.jsonPath === jsonPath) {
            return;
        }
        const entry = { id, jsonPath, running: false, dirty: false, since: null, pending: null, error: null };
        const pendingSet = readChangeSet(livePendingPath(jsonPath));
        if (pendingSet && pendingSet.kind === 'live' && typeof pendingSet.head === 'string') {
            entry.since = pendingSet.head;
            entry.pending = { head: pendingSet.head, fileCount: (pendingSet.files || []).length, at: null };
        }
        this.live.set(id, entry);
        this.scheduleLive(entry);
    }

    /** `callcanvas notify` (the Claude Code hook after every tool call): rebuild every live canvas. */
    notifyLive() {
        for (const entry of this.live.values()) {
            this.scheduleLive(entry);
        }
        return { ok: true, live: this.live.size };
    }

    /** One rebuild at a time; a notification during one asks for exactly one more afterwards. */
    scheduleLive(entry) {
        if (entry.running) {
            entry.dirty = true;
            return;
        }
        this.runLive(entry).catch(error => this.log(`live rebuild failed: ${error && error.stack ? error.stack : error}`));
    }

    async runLive(entry) {
        entry.running = true;
        this.runningCommands++;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        this.broadcastLive(entry);
        this.beginWork('live: 変更集合を更新中');
        try {
            do {
                entry.dirty = false;
                const result = await this.shim.vscode.commands.executeCommand(
                    'callcanvas.refreshLiveChangeSet', entry.jsonPath, entry.since || undefined
                );
                if (this.live.get(entry.id) !== entry) {
                    return;                                   // closed meanwhile
                }
                if (!result || !result.success) {
                    entry.error = (result && result.error) || 'ライブの変更集合を作り直せませんでした';
                    continue;
                }
                entry.error = result.javaError || result.clientsideError || null;
                entry.since = result.head;
                if (result.changed) {
                    entry.pending = {
                        head: result.head,
                        fileCount: result.fileCount,
                        islandCount: result.islandCount,
                        windowCount: result.windowCount,
                        at: Date.now()
                    };
                }
                this.broadcastLive(entry);
            } while (entry.dirty);
        } finally {
            entry.running = false;
            this.endWork();
            this.runningCommands--;
            if (this.server.clients.size === 0) {
                this.scheduleIdleShutdown();
            }
            this.broadcastLive(entry);
        }
    }

    /**
     * What the badge of a canvas shows: a live canvas's state (rebuilding, a rebuild waiting to
     * be taken in, the last error), or whether a commit / workbench change set can switch to live.
     */
    liveStatus(canvasId) {
        const entry = this.live.get(canvasId);
        if (entry) {
            const summary = this.changeSets.get(canvasId);
            return {
                ok: true,
                live: true,
                running: entry.running,
                pending: entry.pending ? {
                    fileCount: entry.pending.fileCount,
                    islandCount: entry.pending.islandCount === undefined ? null : entry.pending.islandCount,
                    at: entry.pending.at
                } : null,
                error: entry.error,
                // Without the hook nothing asks for a rebuild: the badge says so instead of "up to date".
                hookInstalled: notifyHookSettings(this.projectRoot).length > 0,
                fileCount: summary ? summary.fileCount : 0,
                islandCount: summary ? summary.islandCount : 0
            };
        }
        const summary = this.changeSets.get(canvasId);
        return { ok: true, live: false, canStart: !!(summary && (summary.kind === 'commit' || summary.kind === 'workbench')) };
    }

    /**
     * The change set summary `open` answers with. A live one also says whether the Claude Code
     * hook is installed: without it nothing ever asks for a rebuild, and Neovim should say so.
     */
    liveAwareSummary(canvasId) {
        const summary = this.changeSets.get(canvasId);
        if (!summary || summary.kind !== 'live') {
            return summary;
        }
        return Object.assign({}, summary, { hookInstalled: notifyHookSettings(this.projectRoot).length > 0 });
    }

    broadcastLive(entry) {
        this.server.broadcastTo(entry.id, { kind: 'live', state: this.liveStatus(entry.id) });
    }

    /**
     * Take the waiting rebuild in: it replaces the canvas JSON, and the tabs of the canvas
     * reload (the page is served from the JSON, see withSavedCanvasData). Edits made on the
     * canvas since are replaced with it.
     */
    applyLive(canvasId) {
        const entry = this.live.get(canvasId);
        if (!entry) {
            return { ok: false, error: 'ライブのキャンバスではありません' };
        }
        const pendingPath = livePendingPath(entry.jsonPath);
        if (!entry.pending || !fs.existsSync(pendingPath)) {
            entry.pending = null;
            this.broadcastLive(entry);
            return { ok: false, error: '取り込む更新はありません' };
        }
        fs.renameSync(pendingPath, entry.jsonPath);
        entry.pending = null;
        const summary = changeSetSummary(entry.jsonPath);
        if (summary) {
            this.changeSets.set(canvasId, summary);
        }
        this.broadcastLive(entry);
        this.server.broadcastTo(canvasId, { kind: 'navigate' });
        return { ok: true };
    }

    /**
     * Switch a commit / workbench change set to live: a live canvas with the same base (so
     * what it already shows stays, and what changes from now on is added), followed from the
     * working tree. Answers like `open`, so the browser can go to the new canvas.
     */
    async startLive(canvasId) {
        const entry = this.server.canvases.get(canvasId);
        const changeSet = entry && entry.jsonPath ? readChangeSet(entry.jsonPath) : null;
        if (!changeSet || (changeSet.kind !== 'commit' && changeSet.kind !== 'workbench') || !changeSet.base) {
            return { ok: false, error: 'コミットかワークベンチの変更集合キャンバスからだけライブにできます' };
        }
        return this.open({
            file: path.dirname(entry.jsonPath),
            command: CHANGE_SET_COMMAND,
            args: [`live:${changeSet.base}`]
        });
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

    /** Is the browser allowed to drive Neovim (jump to source)? */
    nvimJumpEnabled() {
        return this.config.lookup('callcanvas.nvimJump', false) === true;
    }

    /**
     * Tell Neovim about long-running work, so it can keep a line on screen instead of
     * a notification that scrolls away. Throttled: this crosses an `nvim --remote-expr`
     * process per call, and the elapsed-time ticking is Neovim's own job.
     */
    nvimProgress(text, active) {
        if (!this.nvim.available) {
            return;
        }
        const now = Date.now();
        if (active && text === this.lastProgressText && now - this.lastProgressAt < 1000) {
            return;
        }
        this.lastProgressText = active ? text : null;
        this.lastProgressAt = now;
        this.nvim.progress(text, active);
    }

    /** Something started running: put the line up and keep it up. */
    beginWork(label) {
        this.workDepth++;
        this.nvimProgress(label, true);
    }

    /** Same work, new status text. */
    updateWork(text) {
        if (this.workDepth === 0) {
            this.workDepth++;
        }
        this.nvimProgress(text, true);
    }

    /**
     * Work finished. The line goes away when nothing is running any more; an outcome
     * worth reading (`call index built`) is passed as `finalText` and lingers briefly,
     * while plain "the analysis returned" just clears.
     */
    endWork(finalText) {
        this.workDepth = Math.max(0, this.workDepth - 1);
        if (this.workDepth === 0) {
            this.lastProgressText = null;
            this.nvimProgress(finalText || '', false);
        } else if (finalText) {
            this.nvimProgress(finalText, true);
        }
    }

    /**
     * Output channel lines from the extensions. The automatic call index build (started
     * by an analysis that finds no index) runs for minutes and reports only here, so
     * without this the user is told "building in background" once and then nothing.
     */
    onOutput(channel, line) {
        if (!line.startsWith(AUTO_INDEX_PREFIX)) {
            return;
        }
        const body = line.slice(AUTO_INDEX_PREFIX.length).trim();
        if (/^Building index for:/.test(body)) {
            this.indexBuilding = true;
            this.beginWork('building the call index');
            return;
        }
        if (/^Index built successfully/.test(body)) {
            this.endIndexBuild('call index built');
            return;
        }
        if (/^(Failed|Error|Process exited|JAR not found|No source directories)/.test(body)) {
            this.endIndexBuild(`call index build failed: ${body}`);
            return;
        }
        // The analyzer's own progress ("Found 22 Java files", "117 methods indexed").
        const info = body.match(/^\[INFO\]\s*(.+)$/);
        if (info && this.indexBuilding) {
            this.updateWork(`call index — ${info[1]}`);
        }
    }

    /** The background build reports both an error line and a "Failed after" line. */
    endIndexBuild(finalText) {
        if (!this.indexBuilding) {
            return;
        }
        this.indexBuilding = false;
        this.endWork(finalText);
    }

    /** Show a file in the browser's own panel instead of opening an editor. */
    showFileInBrowser(fsPath, line) {
        this.sendToUi({ kind: 'show-file', path: fsPath, line: Math.max(1, Number(line) || 1) });
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
            // The browser only hears about work that has a title, exactly as before.
            // Neovim hears about all of it: the user is looking at the editor they
            // pressed the key in, not necessarily at a browser tab.
            progressBegin(title) {
                if (title) {
                    host.sendToUi({ kind: 'progress', text: title, active: true });
                }
                host.beginWork(title || 'working ...');
            },
            progressUpdate(text) {
                host.sendToUi({ kind: 'progress', text, active: true });
                host.updateWork(text);
            },
            progressEnd(title) {
                if (title) {
                    host.sendToUi({ kind: 'progress', text: title, active: false });
                }
                host.endWork();
            },

            async message(level, message, items) {
                host.log(`${level}: ${message}`);
                if (level === 'error') {
                    host.lastError = String(message);
                } else if (level === 'info') {
                    host.lastInfo = String(message);
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

        // A QuickPick ("which project?") must not be answered silently: picking the
        // wrong project means minutes spent indexing the wrong tree.
        if (this.nvim.available && type === 'pick') {
            // The items are {label, description} for the browser's dialog; Neovim gets
            // one line each, so the description has to be on it (a bare label is often
            // just a hash or a module name).
            const labels = quickPickLines(payload.items);
            const choice = await this.nvim.select(payload.placeHolder, labels);
            if (choice === -2) {
                this.log('pick cancelled in nvim');
                return null;
            }
            if (choice >= 0) {
                return choice;
            }
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
        this.scheduleIdleShutdown();
    }

    /**
     * Follow the life of a Neovim process: once no watched Neovim is alive, shut down.
     * Polling (not a socket) so a crash or kill -9 is noticed as well as :qa.
     * @param {number} pid
     */
    watchNvim(pid) {
        if (!Number.isInteger(pid) || pid <= 0) {
            return;
        }
        this.nvimPids.add(pid);
        if (this.nvimWatch) {
            return;
        }
        this.nvimWatch = setInterval(() => {
            for (const watched of this.nvimPids) {
                if (!isProcessAlive(watched)) {
                    this.nvimPids.delete(watched);
                }
            }
            // An index build still running is left to finish: its result is on disk and
            // is what the next session starts from.
            if (this.nvimPids.size > 0 || this.runningCommands > 0) {
                return;
            }
            clearInterval(this.nvimWatch);
            this.nvimWatch = null;
            this.log('Neovim exited — shutting down');
            // Nobody is left to draw a progress line for.
            this.nvim.address = null;
            this.shutdown();
        }, NVIM_WATCH_INTERVAL_MS);
    }

    /**
     * Arm the "no browser left" shutdown. A command still running keeps the host
     * alive: building the call index takes minutes and nobody is watching a tab.
     */
    scheduleIdleShutdown() {
        if (!this.hadClient || !this.idleTimeoutMs || this.runningCommands > 0) {
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

    /** @param {number} code exit status — non-zero when a one-shot command failed */
    async shutdown(code = 0) {
        // Nothing is running once this process is gone, so take the line down first —
        // otherwise a spinner keeps ticking in Neovim for work that ended.
        if (this.nvim.available) {
            this.workDepth = 0;
            await this.nvim.progress('', false);
        }
        this.clearSession();
        await this.server.close();
        process.exit(code);
    }
}

module.exports = {
    CallCanvasHost, detectProjectRoot, findMultiModuleRoot, sessionFile, sessionDir, persistentToken,
    extractJsonPath, canvasIdFor, OPEN_COMMANDS, quickPickLines, changeSetSummary, changeSetTitle, livePendingPath,
    NOTIFY_HOOK_PATTERN, claudeUserSettingsPath, notifyHookSettings
};
