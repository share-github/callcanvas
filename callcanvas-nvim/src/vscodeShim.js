'use strict';
/**
 * A `vscode` module stand-in that lets the compiled CallCanvas extensions
 * (`<ext>/out/*.js`) run inside a plain Node process.
 *
 * The extensions are used AS BUILT — nothing is re-implemented here, so analysis
 * behaviour, signature resolution and the viewer HTML stay identical to the VSIX.
 * Only the editor-facing edges are redirected:
 *   - webview      -> the HTTP/SSE bridge (browser)
 *   - editor jumps -> Neovim (`nvim --server ... --remote-expr`)
 *   - dialogs      -> browser prompt, or Neovim `input()` when no browser is attached
 */
const fs = require('fs');
const path = require('path');
const {
    Uri, Position, Range, Selection,
    ViewColumn, ProgressLocation, StatusBarAlignment, ExtensionMode,
    ConfigurationTarget, EndOfLine, languageIdFor
} = require('./types');

const WALK_SKIP_DIRS = new Set([
    '.git', 'node_modules', '.gradle', '.idea', '.vscode', 'out', 'dist',
    '.callcanvas-cache', '.next', 'coverage'
]);

/** Translate a vscode glob (`**​/pom.xml`) into a RegExp matched against a relative path. */
function globToRegExp(glob) {
    let re = '';
    const g = String(glob).replace(/\\/g, '/');
    for (let i = 0; i < g.length; i++) {
        const c = g[i];
        if (c === '*') {
            if (g[i + 1] === '*') {
                // `**/` matches zero or more directories
                if (g[i + 2] === '/') {
                    re += '(?:[^/]+/)*';
                    i += 2;
                } else {
                    re += '.*';
                    i += 1;
                }
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '{') {
            re += '(?:';
        } else if (c === '}') {
            re += ')';
        } else if (c === ',') {
            re += '|';
        } else {
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${re}$`);
}

function makeDocument(fsPath) {
    const absolute = path.resolve(fsPath);
    const text = fs.readFileSync(absolute, 'utf8');
    const lines = text.split(/\r?\n/);
    const doc = {
        uri: Uri.file(absolute),
        fileName: absolute,
        languageId: languageIdFor(absolute),
        version: 1,
        isUntitled: false,
        isDirty: false,
        isClosed: false,
        eol: EndOfLine.LF,
        lineCount: lines.length,
        getText(range) {
            if (!range) {
                return text;
            }
            const out = [];
            for (let n = range.start.line; n <= Math.min(range.end.line, lines.length - 1); n++) {
                let line = lines[n];
                if (n === range.end.line) {
                    line = line.substring(0, range.end.character);
                }
                if (n === range.start.line) {
                    line = line.substring(range.start.character);
                }
                out.push(line);
            }
            return out.join('\n');
        },
        lineAt(lineOrPosition) {
            const n = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
            const value = lines[n] !== undefined ? lines[n] : '';
            return {
                lineNumber: n,
                text: value,
                range: new Range(new Position(n, 0), new Position(n, value.length)),
                rangeIncludingLineBreak: new Range(new Position(n, 0), new Position(n + 1, 0)),
                firstNonWhitespaceCharacterIndex: value.search(/\S|$/),
                isEmptyOrWhitespace: value.trim().length === 0
            };
        },
        offsetAt(position) {
            let offset = 0;
            for (let n = 0; n < position.line && n < lines.length; n++) {
                offset += lines[n].length + 1;
            }
            return offset + position.character;
        },
        positionAt(offset) {
            let remaining = offset;
            for (let n = 0; n < lines.length; n++) {
                if (remaining <= lines[n].length) {
                    return new Position(n, remaining);
                }
                remaining -= lines[n].length + 1;
            }
            return new Position(Math.max(0, lines.length - 1), 0);
        },
        async save() {
            return true;
        },
        validatePosition(p) {
            return p;
        },
        validateRange(r) {
            return r;
        }
    };
    return doc;
}

/** Build the fake "active editor" that carries the Neovim caret position. */
function makeEditor(fsPath, line /* 1-based */) {
    const document = makeDocument(fsPath);
    const zeroBased = Math.max(0, (Number(line) || 1) - 1);
    const active = new Position(Math.min(zeroBased, Math.max(0, document.lineCount - 1)), 0);
    const selection = new Selection(active, active);
    return {
        document,
        selection,
        selections: [selection],
        visibleRanges: [new Range(active, active)],
        viewColumn: ViewColumn.One,
        options: {},
        async edit() {
            return false;
        },
        revealRange() {},
        show() {},
        hide() {}
    };
}

function memento() {
    const store = new Map();
    return {
        get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
        update: async (key, value) => {
            store.set(key, value);
        },
        keys: () => [...store.keys()],
        setKeysForSync: () => {}
    };
}

/**
 * @param {object} host
 * @param {string} host.projectRoot
 * @param {import('./config').ConfigStore} host.config
 * @param {import('./nvimClient').NvimClient} host.nvim
 * @param {object} host.ui        { input, pick, openPath, savePath, message, progress* }
 * @param {object} host.panelSink { onHtml, onPost, onTitle, onDispose, assetUrl }
 * @param {Record<string,string>} host.extensionPaths  extension id -> directory
 * @param {(channel: string, line: string) => void} [host.onOutput]  output channel lines
 * @param {(msg: string) => void} host.log
 */
function createVscodeShim(host) {
    const log = host.log || (() => {});
    const commands = new Map();
    let activeEditor = null;
    const outputChannels = new Map();

    const workspaceFolders = [{
        uri: Uri.file(host.projectRoot),
        name: path.basename(host.projectRoot),
        index: 0
    }];

    function walk(dir, relBase, matcher, excludeMatcher, max, results, depth) {
        if (results.length >= max || depth > 12) {
            return;
        }
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (results.length >= max) {
                return;
            }
            const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (WALK_SKIP_DIRS.has(entry.name)) {
                    continue;
                }
                walk(path.join(dir, entry.name), rel, matcher, excludeMatcher, max, results, depth + 1);
            } else if (matcher.test(rel) && !(excludeMatcher && excludeMatcher.test(rel))) {
                results.push(Uri.file(path.join(dir, entry.name)));
            }
        }
    }

    const vscode = {
        version: '1.85.0-callcanvas-nvim',
        Uri, Position, Range, Selection,
        ViewColumn, ProgressLocation, StatusBarAlignment, ExtensionMode,
        ConfigurationTarget, EndOfLine,

        Disposable: class Disposable {
            constructor(fn) {
                this._fn = fn;
            }
            dispose() {
                if (this._fn) {
                    this._fn();
                }
            }
            static from(...items) {
                return new Disposable(() => items.forEach(i => i && i.dispose && i.dispose()));
            }
        },

        EventEmitter: class EventEmitter {
            constructor() {
                this._listeners = [];
                this.event = (listener, thisArg, disposables) => {
                    const bound = thisArg ? listener.bind(thisArg) : listener;
                    this._listeners.push(bound);
                    const disposable = {
                        dispose: () => {
                            this._listeners = this._listeners.filter(l => l !== bound);
                        }
                    };
                    if (Array.isArray(disposables)) {
                        disposables.push(disposable);
                    }
                    return disposable;
                };
            }
            fire(value) {
                for (const listener of [...this._listeners]) {
                    listener(value);
                }
            }
            dispose() {
                this._listeners = [];
            }
        },

        commands: {
            registerCommand(id, callback, thisArg) {
                commands.set(id, thisArg ? callback.bind(thisArg) : callback);
                log(`command registered: ${id}`);
                return { dispose: () => commands.delete(id) };
            },
            registerTextEditorCommand(id, callback) {
                return vscode.commands.registerCommand(id, (...args) => callback(activeEditor, undefined, ...args));
            },
            async executeCommand(id, ...args) {
                // Built-in commands the extensions rely on
                if (id === 'vscode.open') {
                    const uri = args[0];
                    const options = args[1] || {};
                    const line = options.selection && options.selection.start
                        ? options.selection.start.line + 1
                        : 1;
                    await jumpAndReport(uri.fsPath, line);
                    return undefined;
                }
                if (id === 'setContext' || id === 'workbench.action.closeActiveEditor') {
                    return undefined;
                }
                const handler = commands.get(id);
                if (!handler) {
                    throw new Error(`command '${id}' not found`);
                }
                return handler(...args);
            },
            async getCommands() {
                return [...commands.keys()];
            }
        },

        extensions: {
            getExtension(id) {
                const dir = host.extensionPaths[id];
                if (!dir) {
                    return undefined;
                }
                return {
                    id,
                    extensionPath: dir,
                    extensionUri: Uri.file(dir),
                    isActive: true,
                    exports: undefined,
                    packageJSON: (() => {
                        try {
                            return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
                        } catch {
                            return {};
                        }
                    })(),
                    activate: async () => undefined
                };
            },
            get all() {
                return Object.keys(host.extensionPaths).map(id => vscode.extensions.getExtension(id));
            }
        },

        workspace: {
            workspaceFolders,
            name: path.basename(host.projectRoot),
            rootPath: host.projectRoot,
            getConfiguration(section) {
                return host.config.section(section);
            },
            getWorkspaceFolder(uri) {
                return uri && uri.fsPath && uri.fsPath.startsWith(host.projectRoot)
                    ? workspaceFolders[0]
                    : undefined;
            },
            asRelativePath(pathOrUri) {
                const p = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
                return path.relative(host.projectRoot, p);
            },
            async findFiles(include, exclude, maxResults = 1000) {
                const matcher = globToRegExp(include);
                const excludeMatcher = exclude ? globToRegExp(exclude) : null;
                const results = [];
                walk(host.projectRoot, '', matcher, excludeMatcher, maxResults, results, 0);
                log(`findFiles(${include}) -> ${results.length}`);
                return results;
            },
            async openTextDocument(uriOrPath) {
                const fsPath = typeof uriOrPath === 'string'
                    ? uriOrPath
                    : (uriOrPath && uriOrPath.fsPath) || String(uriOrPath);
                return makeDocument(fsPath);
            },
            async saveAll() {
                return true;
            },
            onDidChangeConfiguration() {
                return { dispose() {} };
            },
            onDidSaveTextDocument() {
                return { dispose() {} };
            },
            createFileSystemWatcher() {
                return { onDidChange: () => ({ dispose() {} }), onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} };
            },
            fs: {
                async readFile(uri) {
                    return fs.readFileSync(uri.fsPath);
                },
                async writeFile(uri, content) {
                    fs.writeFileSync(uri.fsPath, content);
                },
                async stat(uri) {
                    const s = fs.statSync(uri.fsPath);
                    return { type: s.isDirectory() ? 2 : 1, size: s.size, ctime: s.ctimeMs, mtime: s.mtimeMs };
                }
            }
        },

        window: {
            get activeTextEditor() {
                return activeEditor;
            },
            get visibleTextEditors() {
                return activeEditor ? [activeEditor] : [];
            },
            get activeColorTheme() {
                return { kind: 2 };
            },
            onDidChangeActiveTextEditor() {
                return { dispose() {} };
            },

            createOutputChannel(name) {
                if (outputChannels.has(name)) {
                    return outputChannels.get(name);
                }
                // The extensions report long-running background work (the automatic
                // call index build) only through their output channel, so the host
                // listens in to turn it into progress the user can see.
                const emit = (value) => {
                    log(`[${name}] ${value}`);
                    if (host.onOutput) {
                        host.onOutput(name, String(value));
                    }
                };
                const channel = {
                    name,
                    append: emit,
                    appendLine: emit,
                    replace: () => {},
                    clear: () => {},
                    show: () => {},
                    hide: () => {},
                    dispose: () => outputChannels.delete(name)
                };
                outputChannels.set(name, channel);
                return channel;
            },

            async showInformationMessage(message, ...items) {
                return host.ui.message('info', message, flattenItems(items));
            },
            async showWarningMessage(message, ...items) {
                return host.ui.message('warning', message, flattenItems(items));
            },
            async showErrorMessage(message, ...items) {
                return host.ui.message('error', message, flattenItems(items));
            },

            async showInputBox(options = {}) {
                return host.ui.input(options);
            },
            async showQuickPick(items, options = {}) {
                return host.ui.pick(await items, options);
            },
            async showOpenDialog(options = {}) {
                const picked = await host.ui.openPath(options);
                return picked ? [Uri.file(picked)] : undefined;
            },
            async showSaveDialog(options = {}) {
                const picked = await host.ui.savePath(options);
                return picked ? Uri.file(picked) : undefined;
            },

            async withProgress(options, task) {
                const title = options && options.title ? options.title : '';
                // Begin/end rather than progress(text, active): the host keeps one line
                // on screen for as long as anything is running, so the pair has to be
                // balanced even when this work has no title of its own.
                host.ui.progressBegin(title);
                try {
                    return await task(
                        { report: (value) => value && value.message && host.ui.progressUpdate(value.message) },
                        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
                    );
                } finally {
                    host.ui.progressEnd(title);
                }
            },

            async showTextDocument(documentOrUri, optionsOrColumn) {
                const fsPath = documentOrUri && documentOrUri.uri
                    ? documentOrUri.uri.fsPath
                    : (documentOrUri && documentOrUri.fsPath) || String(documentOrUri);
                const options = (optionsOrColumn && typeof optionsOrColumn === 'object') ? optionsOrColumn : {};
                const line = options.selection && options.selection.start
                    ? options.selection.start.line + 1
                    : 1;
                await jumpAndReport(fsPath, line);
                return makeEditor(fsPath, line);
            },

            createWebviewPanel(viewType, title, showOptions, options) {
                return createPanel(viewType, title, options);
            },

            createStatusBarItem() {
                return { text: '', tooltip: '', command: undefined, show() {}, hide() {}, dispose() {} };
            },
            setStatusBarMessage() {
                return { dispose() {} };
            }
        },

        env: {
            appName: 'CallCanvas nvim host',
            machineId: 'callcanvas-nvim',
            async openExternal(uri) {
                log(`openExternal: ${uri}`);
                return true;
            },
            clipboard: {
                async writeText() {},
                async readText() {
                    return '';
                }
            }
        },

        languages: {
            registerCallHierarchyProvider() {
                return { dispose() {} };
            }
        }
    };

    /**
     * "Open this in an editor" from extension code. By default there is no editor to
     * drive — the browser shows the file itself — so send it there. Driving Neovim is
     * opt-in (`callcanvas.nvimJump`).
     */
    async function jumpAndReport(fsPath, line) {
        if (host.nvimJumpEnabled && !host.nvimJumpEnabled()) {
            if (host.showFileInBrowser) {
                host.showFileInBrowser(fsPath, line);
            }
            return true;
        }
        const result = await host.nvim.jump(fsPath, line);
        if (result && result.ok) {
            return true;
        }
        const reason = (result && result.error) || 'unknown error';
        host.ui.message('error', `Neovim へのジャンプに失敗: ${reason}`, []);
        return false;
    }

    function flattenItems(items) {
        const flat = [];
        for (const item of items) {
            if (Array.isArray(item)) {
                flat.push(...item);
            } else if (item && typeof item === 'object' && item.modal !== undefined) {
                // MessageOptions — ignored
            } else if (item !== undefined) {
                flat.push(item);
            }
        }
        return flat;
    }

    function createPanel(viewType, title, options) {
        const messageListeners = [];
        const disposeListeners = [];
        let disposed = false;
        let html = '';
        let currentTitle = title;

        const webview = {
            options: options || {},
            cspSource: "'self'",
            get html() {
                return html;
            },
            set html(value) {
                html = value;
                host.panelSink.onHtml(panel, value);
            },
            async postMessage(message) {
                if (disposed) {
                    return false;
                }
                host.panelSink.onPost(panel, message);
                return true;
            },
            onDidReceiveMessage(listener, thisArg, disposables) {
                const bound = thisArg ? listener.bind(thisArg) : listener;
                messageListeners.push(bound);
                const disposable = {
                    dispose: () => {
                        const i = messageListeners.indexOf(bound);
                        if (i >= 0) {
                            messageListeners.splice(i, 1);
                        }
                    }
                };
                if (Array.isArray(disposables)) {
                    disposables.push(disposable);
                }
                return disposable;
            },
            asWebviewUri(uri) {
                return host.panelSink.assetUrl(uri.fsPath);
            }
        };

        const panel = {
            viewType,
            webview,
            visible: true,
            active: true,
            viewColumn: ViewColumn.One,
            options: options || {},
            get title() {
                return currentTitle;
            },
            set title(value) {
                currentTitle = value;
                host.panelSink.onTitle(panel, value);
            },
            iconPath: undefined,
            reveal() {
                host.panelSink.onReveal(panel);
            },
            onDidDispose(listener, thisArg, disposables) {
                const bound = thisArg ? listener.bind(thisArg) : listener;
                disposeListeners.push(bound);
                const disposable = { dispose: () => {} };
                if (Array.isArray(disposables)) {
                    disposables.push(disposable);
                }
                return disposable;
            },
            onDidChangeViewState() {
                return { dispose() {} };
            },
            dispose() {
                if (disposed) {
                    return;
                }
                disposed = true;
                for (const listener of disposeListeners) {
                    try {
                        listener();
                    } catch (e) {
                        log(`panel dispose listener failed: ${e}`);
                    }
                }
                host.panelSink.onDispose(panel);
            },
            /** Host-side entry point: deliver a message coming from the browser. */
            _receive(message) {
                for (const listener of [...messageListeners]) {
                    Promise.resolve()
                        .then(() => listener(message))
                        .catch(e => log(`onDidReceiveMessage failed: ${e && e.stack ? e.stack : e}`));
                }
            }
        };
        host.panelSink.onCreate(panel);
        return panel;
    }

    return {
        vscode,
        /** Point the fake active editor at a file + 1-based caret line. */
        setActiveEditor(fsPath, line) {
            activeEditor = makeEditor(fsPath, line);
            return activeEditor;
        },
        clearActiveEditor() {
            activeEditor = null;
        },
        makeExtensionContext(dir) {
            // Never inside the extension (or project) directory: this host is not
            // the one that owns those trees.
            const storage = path.join(require('os').tmpdir(), 'callcanvas-nvim', 'storage');
            return {
                extensionPath: dir,
                extensionUri: Uri.file(dir),
                subscriptions: [],
                asAbsolutePath: (relative) => path.join(dir, relative),
                globalState: memento(),
                workspaceState: memento(),
                secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
                extensionMode: ExtensionMode.Production,
                storageUri: Uri.file(storage),
                globalStorageUri: Uri.file(storage),
                logUri: Uri.file(storage),
                environmentVariableCollection: { replace() {}, append() {}, prepend() {}, clear() {} },
                extension: { id: 'callcanvas-nvim', packageJSON: {} }
            };
        },
        commands
    };
}

module.exports = { createVscodeShim, makeDocument, makeEditor, globToRegExp };
