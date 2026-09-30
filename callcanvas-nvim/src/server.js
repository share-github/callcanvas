'use strict';
/**
 * Local HTTP server that delivers viewer pages to a browser and bridges them
 * back to the in-process extension host (see vscodeShim.js).
 *
 * Browser -> host : POST /api/message  (webview postMessage)
 * Host -> browser : GET  /api/events   (Server-Sent Events)
 *
 * Several canvases can be open at once, exactly like several viewer tabs in
 * VS Code:
 *   /              the newest canvas, and it follows: opening another canvas
 *                  reloads this tab. Bookmark this one — no URL copying.
 *   /c/<id>        one specific canvas, pinned. Keeps showing that canvas even
 *                  when newer ones are opened; reloads when that canvas itself
 *                  is re-analysed. `id` is derived from the canvas JSON path, so
 *                  the permalink survives re-analysis.
 *   /canvases      index of everything currently open.
 *
 * Everything is loopback-bound and token-guarded, so other local processes and
 * random web pages cannot drive Neovim or read source files through this server.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8'
};

const SERVER_CSP = [
    "default-src 'none'",
    "connect-src 'self'",
    "style-src 'unsafe-inline' 'self'",
    "script-src 'unsafe-inline' 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:"
].join('; ');

const BRIDGE_CLIENT = path.join(__dirname, 'bridge.client.js');

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

/**
 * The viewer HTML embeds the canvas data as of the moment the panel was opened, but
 * the viewer keeps saving edits to the canvas JSON file (saveData). Serve what is on
 * disk now so a browser reload — in any tab of that canvas — shows the saved edits.
 * Anything unexpected (no path, unreadable/empty/broken JSON, no initialData in the
 * HTML) keeps the HTML as it was.
 */
function withSavedCanvasData(html, jsonPath) {
    if (!jsonPath) {
        return html;
    }
    let data;
    try {
        const raw = fs.readFileSync(jsonPath, 'utf8').trim();
        if (!raw) {
            return html;
        }
        data = JSON.parse(raw);
    } catch {
        return html;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return html;
    }
    // Same defaults the viewer extension applies when it opens a JSON file
    if (!data.windows) data.windows = [];
    if (!data.connections) data.connections = [];
    if (data.autoLayout === undefined) data.autoLayout = true;

    // `initialData: <one-line JSON>,\n<indent>jsonFilePath:` — JSON.stringify has no raw newline
    const start = html.indexOf('initialData: ');
    if (start < 0) {
        return html;
    }
    const valueStart = start + 'initialData: '.length;
    const end = html.slice(valueStart).search(/,\r?\n\s*jsonFilePath: /);
    if (end < 0) {
        return html;
    }
    const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');
    return html.slice(0, valueStart) + dataJson + html.slice(valueStart + end);
}

class ViewerServer {
    /**
     * @param {object} options
     * @param {string} options.host            bind address (default 127.0.0.1)
     * @param {number} options.port            0 = pick a free port
     * @param {string[]} options.assetRoots    directories assets may be served from
     * @param {(msg: string) => void} options.log
     * @param {object} options.handlers        { onMessage, onUiReply, onOpen, onClientCount, onShutdown }
     * @param {string} [options.token]         reuse this token (keeps the URL bookmarkable)
     * @param {boolean} [options.auth]         false disables the token check
     * @param {object} [options.bridgeSettings] values the browser-side bridge needs
     *                                          (browser key bindings, …)
     * @param {string} [options.fileRoot]       project root that /api/file may read from
     */
    constructor(options) {
        this.bindHost = options.host || '127.0.0.1';
        this.port = options.port || 0;
        this.assetRoots = (options.assetRoots || []).map(p => path.resolve(p));
        this.log = options.log || (() => {});
        this.handlers = options.handlers || {};
        this.token = options.token || crypto.randomBytes(24).toString('hex');
        this.authEnabled = options.auth !== false;
        this.bridgeSettings = options.bridgeSettings || {};
        this.fileRoot = options.fileRoot ? path.resolve(options.fileRoot) : null;

        /** @type {Map<string, {id: string, html: string, title: string, jsonPath: string, pending: object[], updatedAt: number}>} */
        this.canvases = new Map();
        this.latestId = null;
        /** @type {Set<{res: object, canvasId: string, follow: boolean}>} */
        this.clients = new Set();
        this.anonCounter = 0;
        /** wrong-guess counter for the short unlock path. See unlockUrl. */
        this.unlockFailures = 0;

        this.server = http.createServer((req, res) => this.route(req, res));
    }

    listen() {
        return new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.port, this.bindHost, () => {
                this.port = this.server.address().port;
                this.log(`listening on http://${this.bindHost}:${this.port}`);
                resolve({ host: this.bindHost, port: this.port, token: this.token });
            });
        });
    }

    get origin() {
        const displayHost = this.bindHost === '0.0.0.0' ? '127.0.0.1' : this.bindHost;
        return `http://${displayHost}:${this.port}`;
    }

    /** The URL to open/bookmark: always shows the newest canvas. */
    get url() {
        return this.authEnabled ? `${this.origin}/?t=${this.token}` : `${this.origin}/`;
    }

    /** Same page, without the token — usable once the cookie is set. */
    get bookmarkUrl() {
        return `${this.origin}/`;
    }

    /** Stable permalink for one canvas (survives re-analysis of the same JSON). */
    permalink(canvasId) {
        const suffix = this.authEnabled ? `?t=${this.token}` : '';
        return `${this.origin}/c/${canvasId}${suffix}`;
    }

    /**
     * A short URL that sets the auth cookie and redirects to `/`.
     *
     * The long `?t=<48 hex>` URL is painful to paste out of a terminal
     * notification, so the first visit can use e.g. `http://127.0.0.1:7333/k/1a2b3c4d`
     * instead — short enough to type.
     *
     * It is deliberately **stable and reusable**: it is derived from the session
     * token, so an older copy of the link (from the clipboard, from scrollback)
     * keeps working. A single-use link broke in practice — browsers prefetch URLs
     * typed in the address bar, which burned the key before the real navigation.
     * Guessing is bounded by unlockFailures instead.
     */
    get unlockKey() {
        return crypto.createHash('sha256').update(`unlock:${this.token}`).digest('hex').slice(0, 8);
    }

    /**
     * @param {string} [canvasId] land on this canvas instead of "the newest one".
     *   This is what makes a second tab possible: the link identifies one canvas,
     *   so pasting it in a new tab does not disturb the tab that follows `/`.
     */
    mintUnlockUrl(canvasId) {
        if (!this.authEnabled) {
            return canvasId ? `${this.origin}/c/${canvasId}` : this.bookmarkUrl;
        }
        // A fresh `:CallCanvas` clears the lockout: the person is demonstrably at
        // the keyboard.
        this.unlockFailures = 0;
        const base = `${this.origin}/k/${this.unlockKey}`;
        return canvasId ? `${base}/${canvasId}` : base;
    }

    /** Check the short unlock key, with a cap on wrong guesses. */
    checkUnlockKey(key) {
        if (this.unlockFailures >= 10) {
            return false;
        }
        const expected = this.unlockKey;
        const given = String(key || '');
        const ok = given.length === expected.length
            && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
        if (!ok) {
            this.unlockFailures += 1;
        }
        return ok;
    }

    get canvasListUrl() {
        const suffix = this.authEnabled ? `?t=${this.token}` : '';
        return `${this.origin}/canvases${suffix}`;
    }

    close() {
        this.broadcastAll({ kind: 'shutdown' });
        for (const client of this.clients) {
            try {
                client.res.end();
            } catch { /* already gone */ }
        }
        this.clients.clear();
        return new Promise(resolve => this.server.close(() => resolve()));
    }

    // --- canvases ---------------------------------------------------------
    /**
     * Publish (or refresh) a canvas page.
     * @param {string} id     canvas id — derive it from the canvas JSON path so the
     *                        permalink stays stable across re-analysis
     * @param {string} html   webview HTML as produced by the viewer extension
     * @param {object} meta   { title, jsonPath }
     */
    setCanvas(id, html, meta = {}) {
        const existing = this.canvases.get(id);
        const entry = {
            id,
            title: meta.title || (existing && existing.title) || 'CallCanvas',
            jsonPath: meta.jsonPath || (existing && existing.jsonPath) || '',
            pending: existing ? existing.pending : [],
            rawHtml: String(html),
            updatedAt: Date.now()
        };
        this.canvases.set(id, entry);

        const becameLatest = this.latestId !== id;
        this.latestId = id;

        if (existing) {
            // A tab pinned to this canvas should show the new content.
            this.broadcastTo(id, { kind: 'navigate' }, { includeFollowers: false });
        }
        if (!existing) {
            // A brand-new canvas: tell the other tabs so they can offer to open it
            // (a click there is a user gesture, so window.open is allowed).
            this.write(
                [...this.clients].filter(client => client.canvasId !== id && !client.follow),
                {
                    kind: 'canvas-added',
                    id,
                    title: entry.title,
                    url: this.permalink(id),
                    shortUrl: this.mintUnlockUrl(id)
                }
            );
        }
        if (becameLatest) {
            // Tabs on `/` follow the newest canvas.
            this.notifyFollowers();
        }
        this.log(`canvas ${id} published (${entry.title})`);
        return entry;
    }

    dropCanvas(id) {
        if (!this.canvases.delete(id)) {
            return;
        }
        if (this.latestId === id) {
            const remaining = [...this.canvases.values()].sort((a, b) => b.updatedAt - a.updatedAt);
            this.latestId = remaining.length > 0 ? remaining[0].id : null;
            this.notifyFollowers();
        }
    }

    get anonId() {
        this.anonCounter += 1;
        return `canvas${this.anonCounter}`;
    }

    /**
     * Rewrite the webview HTML for browser delivery:
     *  - swap the webview CSP (which forbids connect-src) for a server-mode one
     *  - inject the bridge script so `acquireVsCodeApi()` exists before viewer.js runs
     *
     * `follow` marks a tab served from `/`: it reloads when a newer canvas opens.
     */
    render(entry, follow) {
        let out = withSavedCanvasData(String(entry.rawHtml), entry.jsonPath);
        const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${SERVER_CSP}">`;
        if (/<meta http-equiv="Content-Security-Policy"[^>]*>/.test(out)) {
            out = out.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, cspMeta);
        } else {
            out = out.replace(/<head>/i, `<head>\n    ${cspMeta}`);
        }
        const bootstrap = `
    <script>
        window.__CALLCANVAS_BRIDGE__ = {
            token: ${JSON.stringify(this.token)},
            canvasId: ${JSON.stringify(entry.id)},
            follow: ${follow ? 'true' : 'false'},
            canvasTitle: ${JSON.stringify(entry.title)},
            permalink: ${JSON.stringify(this.permalink(entry.id))},
            listUrl: ${JSON.stringify(this.canvasListUrl)},
            settings: ${JSON.stringify(this.bridgeSettings)}
        };
    </script>
    <script src="/bridge.js?t=${this.token}"></script>`;
        return out.replace(/<head>/i, `<head>${bootstrap}`);
    }

    /** URL the webview should use for a local asset file. */
    assetUrl(fsPath) {
        return `/asset?t=${this.token}&p=${encodeURIComponent(path.resolve(fsPath))}`;
    }

    // --- events -----------------------------------------------------------
    /** Send an event to the tabs showing one canvas (followers of `/` included). */
    broadcastTo(canvasId, payload, options = {}) {
        const includeFollowers = options.includeFollowers !== false;
        const targets = [...this.clients].filter(client => (
            client.canvasId === canvasId && (includeFollowers || !client.follow)
        ));
        if (targets.length === 0 && payload.kind === 'post') {
            // Keep messages produced before the tab attached (e.g. the first
            // analysis result) so nothing is silently dropped.
            const entry = this.canvases.get(canvasId);
            if (entry) {
                entry.pending.push(payload);
            }
            return;
        }
        this.write(targets, payload);
    }

    broadcastAll(payload) {
        this.write([...this.clients], payload);
    }

    /** Tabs on `/` reload so they land on the newest canvas. */
    notifyFollowers() {
        const followers = [...this.clients].filter(client => client.follow && client.canvasId !== this.latestId);
        this.write(followers, { kind: 'navigate' });
    }

    write(targets, payload) {
        const data = `data: ${JSON.stringify(payload)}\n\n`;
        for (const client of targets) {
            try {
                client.res.write(data);
            } catch (e) {
                this.log(`SSE write failed: ${e}`);
            }
        }
    }

    /** How many tabs would see this canvas right now. */
    clientsForCanvas(canvasId) {
        return [...this.clients].filter(c => c.canvasId === canvasId || c.follow).length;
    }

    // --- routing ----------------------------------------------------------
    route(req, res) {
        let parsed;
        try {
            parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        } catch {
            res.writeHead(400).end('bad request');
            return;
        }
        const route = parsed.pathname;

        if (route === '/api/ping') {
            this.json(res, 200, { ok: true, pid: process.pid });
            return;
        }

        if (route.startsWith('/k/')) {
            const [key, canvasId] = route.slice(3).split('/').map(decodeURIComponent);
            this.handleUnlock(req, res, key, canvasId);
            return;
        }

        const isPageRoute = route === '/' || route === '/index.html'
            || route === '/canvases' || route.startsWith('/c/');
        if (!this.authorized(req, parsed, isPageRoute)) {
            if (isPageRoute) {
                // Usually a bookmark whose cookie is from an older session (for
                // example after a devcontainer rebuild) — say what to do instead of
                // a bare "forbidden".
                res.writeHead(403, this.pageHeaders({}, false)).end(
                    '<!doctype html><meta charset="utf-8"><title>CallCanvas</title>'
                    + '<body style="font:14px/1.7 sans-serif;padding:2rem">'
                    + '<h1>CallCanvas</h1>'
                    + '<p>This bookmark belongs to an older session.</p>'
                    + '<p>Run <code>:CallCanvas</code> in Neovim and open the short link it '
                    + 'shows once — this bookmark works again afterwards.</p>'
                );
                return;
            }
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden');
            return;
        }

        if (route === '/' || route === '/index.html') {
            this.servePage(res, this.latestId, true);
            return;
        }
        if (route.startsWith('/c/')) {
            this.servePage(res, decodeURIComponent(route.slice(3)), false);
            return;
        }

        switch (route) {
            case '/canvases':
                this.serveCanvasList(res);
                return;
            case '/bridge.js':
                this.serveFile(res, BRIDGE_CLIENT);
                return;
            case '/asset':
                this.serveAsset(res, parsed.searchParams.get('p'));
                return;
            case '/api/events':
                this.serveEvents(req, res, parsed);
                return;
            case '/api/file':
                this.serveSourceFile(res, parsed.searchParams.get('p'), parsed.searchParams.get('line'));
                return;
            case '/api/canvases':
                this.json(res, 200, { ok: true, latest: this.latestId, canvases: this.canvasSummaries() });
                return;
            case '/api/message':
                this.readJson(req, res, body => {
                    if (this.handlers.onMessage) {
                        this.handlers.onMessage(body.message, body.canvasId || this.latestId);
                    }
                    this.json(res, 200, { ok: true });
                });
                return;
            case '/api/ui-reply':
                this.readJson(req, res, body => {
                    if (this.handlers.onUiReply) {
                        this.handlers.onUiReply(body.id, body.value);
                    }
                    this.json(res, 200, { ok: true });
                });
                return;
            case '/api/open':
                this.readJson(req, res, async body => {
                    try {
                        const result = this.handlers.onOpen
                            ? await this.handlers.onOpen(body)
                            : { ok: false, error: 'not supported' };
                        this.json(res, 200, result);
                    } catch (error) {
                        this.json(res, 200, { ok: false, error: String(error && error.message ? error.message : error) });
                    }
                });
                return;
            case '/api/shutdown':
                this.json(res, 200, { ok: true });
                setTimeout(() => {
                    if (this.handlers.onShutdown) {
                        this.handlers.onShutdown();
                    }
                }, 50);
                return;
            default:
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
        }
    }

    canvasSummaries() {
        return [...this.canvases.values()]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(entry => ({
                id: entry.id,
                title: entry.title,
                jsonPath: entry.jsonPath,
                url: this.permalink(entry.id),
                shortUrl: this.mintUnlockUrl(entry.id),
                latest: entry.id === this.latestId,
                tabs: [...this.clients].filter(c => c.canvasId === entry.id).length
            }));
    }

    /**
     * The token normally travels in the query string. Page routes also accept the
     * cookie set on the first tokened visit, so the URL can be bookmarked and
     * reloaded forever without copying it again.
     *
     * Only page routes accept the cookie: everything else is referenced from
     * inside a page, which always carries `?t=`, so no cookie-only request can be
     * forged from another site (the cookie is SameSite=Strict on top of that).
     */
    authorized(req, parsed, isPageRoute) {
        if (!this.authEnabled) {
            return true;
        }
        if (parsed.searchParams.get('t') === this.token) {
            return true;
        }
        return isPageRoute && this.cookieToken(req) === this.token;
    }

    cookieToken(req) {
        const header = req.headers.cookie;
        if (!header) {
            return null;
        }
        for (const part of header.split(';')) {
            const [name, ...rest] = part.trim().split('=');
            if (name === 'cc_token') {
                return rest.join('=');
            }
        }
        return null;
    }

    pageHeaders(extra = {}, withCookie = true) {
        const headers = Object.assign({
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
        }, extra);
        if (withCookie && this.authEnabled) {
            // HttpOnly + SameSite=Strict: another site cannot make the browser
            // send this cookie, so the bookmark is not a CSRF hole.
            headers['Set-Cookie'] =
                `cc_token=${this.token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`;
        }
        return headers;
    }

    /** `/k/<key>`: authorises itself, sets the cookie, then redirects to `/`. */
    handleUnlock(req, res, key, canvasId) {
        // An already-authorised browser is let through whatever the key says — a
        // stale link should never lock someone out of their own viewer.
        const authorised = this.cookieToken(req) === this.token || this.checkUnlockKey(key);
        if (authorised) {
            const target = canvasId ? `/c/${encodeURIComponent(canvasId)}` : '/';
            this.log(`unlock accepted -> ${target}`);
            res.writeHead(302, this.pageHeaders({ Location: target })).end();
            return;
        }
        this.log('unlock rejected');
        res.writeHead(403, this.pageHeaders({}, false)).end(
            '<!doctype html><meta charset="utf-8"><title>CallCanvas</title>'
            + '<body style="font:14px/1.7 sans-serif;padding:2rem">'
            + '<h1>CallCanvas</h1>'
            + '<p>That link does not match this session.</p>'
            + '<p>Run <code>:CallCanvas</code> in Neovim — it puts the current link on '
            + 'your clipboard (and prints it).</p>'
        );
    }

    servePage(res, canvasId, follow) {
        const entry = canvasId ? this.canvases.get(canvasId) : null;
        if (!entry) {
            const message = this.canvases.size === 0
                ? 'No canvas is open yet. Run <code>:CallCanvas</code> in Neovim — this tab reloads itself.'
                : `That canvas is gone. <a href="/canvases?t=${this.token}">See the open canvases</a>.`;
            res.writeHead(404, this.pageHeaders()).end(
                `<!doctype html><meta charset="utf-8"><title>CallCanvas</title>`
                + `<body style="font:14px sans-serif;padding:2rem"><h1>CallCanvas</h1><p>${message}</p>`
            );
            return;
        }
        res.writeHead(200, this.pageHeaders()).end(this.render(entry, follow));
    }

    serveCanvasList(res) {
        const rows = this.canvasSummaries().map(canvas => `
        <li>
            <a href="/c/${encodeURIComponent(canvas.id)}?t=${this.token}">${escapeHtml(canvas.title)}</a>
            ${canvas.latest ? '<em>(latest)</em>' : ''}
            <div style="color:#888;font-size:12px">${escapeHtml(canvas.jsonPath)} — ${canvas.tabs} tab(s)</div>
        </li>`).join('');
        res.writeHead(200, this.pageHeaders()).end(
            `<!doctype html><meta charset="utf-8"><title>CallCanvas — open canvases</title>`
            + `<body style="font:14px sans-serif;padding:2rem;line-height:1.6">`
            + `<h1>Open canvases</h1><ul>${rows || '<li>none</li>'}</ul>`
            + `<p><a href="/?t=${this.token}">newest canvas</a></p>`
        );
    }

    /**
     * Source text for the in-page file viewer.
     *
     * Confined to the project root: a relative path is resolved there, and an
     * absolute path is rejected unless it lives inside it. Nothing else on the
     * machine is readable through this endpoint.
     */
    serveSourceFile(res, rawPath, rawLine) {
        if (!rawPath) {
            this.json(res, 400, { ok: false, error: 'missing p' });
            return;
        }
        if (!this.fileRoot) {
            this.json(res, 503, { ok: false, error: 'no project root configured' });
            return;
        }
        const resolved = this.resolveInProject(String(rawPath));
        if (!resolved) {
            this.log(`file denied or not found: ${rawPath}`);
            this.json(res, 404, { ok: false, error: `not found in the project: ${rawPath}` });
            return;
        }
        let stat;
        try {
            stat = fs.statSync(resolved);
        } catch {
            this.json(res, 404, { ok: false, error: 'not found' });
            return;
        }
        const MAX_BYTES = 4 * 1024 * 1024;
        if (!stat.isFile()) {
            this.json(res, 404, { ok: false, error: 'not a file' });
            return;
        }
        if (stat.size > MAX_BYTES) {
            this.json(res, 413, { ok: false, error: `file is larger than ${MAX_BYTES} bytes` });
            return;
        }
        let text;
        try {
            text = fs.readFileSync(resolved, 'utf8');
        } catch (error) {
            this.json(res, 500, { ok: false, error: String(error.message || error) });
            return;
        }
        const line = Math.max(1, parseInt(rawLine, 10) || 1);
        this.json(res, 200, {
            ok: true,
            path: resolved,
            relPath: path.relative(this.fileRoot, resolved),
            line,
            text
        });
    }

    /** Find `candidate` inside the project root, or null. */
    resolveInProject(candidate) {
        const inside = (target) => target === this.fileRoot || target.startsWith(this.fileRoot + path.sep);

        if (path.isAbsolute(candidate)) {
            const target = path.resolve(candidate);
            return inside(target) && fs.existsSync(target) ? target : null;
        }
        const direct = path.resolve(this.fileRoot, candidate);
        if (inside(direct) && fs.existsSync(direct)) {
            return direct;
        }
        // Multi-module layouts hand out module-relative paths; look for a suffix match.
        const wanted = candidate.replace(/\\/g, '/');
        const found = [];
        const walk = (dir, depth) => {
            if (found.length > 0 || depth > 10) {
                return;
            }
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (found.length > 0) {
                    return;
                }
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (['.git', 'node_modules', '.gradle', 'out', 'dist'].includes(entry.name)) {
                        continue;
                    }
                    walk(full, depth + 1);
                } else if (full.replace(/\\/g, '/').endsWith('/' + wanted)) {
                    found.push(full);
                }
            }
        };
        walk(this.fileRoot, 0);
        return found[0] || null;
    }

    serveFile(res, filePath) {
        fs.readFile(filePath, (error, data) => {
            if (error) {
                res.writeHead(404).end('not found');
                return;
            }
            res.writeHead(200, {
                'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
                'Cache-Control': 'no-cache'
            }).end(data);
        });
    }

    serveAsset(res, rawPath) {
        if (!rawPath) {
            res.writeHead(400).end('missing p');
            return;
        }
        const target = path.resolve(rawPath);
        const allowed = this.assetRoots.some(root => target === root || target.startsWith(root + path.sep));
        if (!allowed) {
            this.log(`asset denied: ${target}`);
            res.writeHead(403).end('forbidden');
            return;
        }
        this.serveFile(res, target);
    }

    serveEvents(req, res, parsed) {
        const canvasId = parsed.searchParams.get('c') || this.latestId || '';
        const follow = parsed.searchParams.get('follow') === '1';

        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.write(': connected\n\n');

        const client = { res, canvasId, follow };
        this.clients.add(client);
        this.log(`tab attached to canvas ${canvasId}${follow ? ' (following)' : ''} — ${this.clients.size} tab(s)`);

        const entry = this.canvases.get(canvasId);
        if (entry && entry.pending.length > 0) {
            this.write([client], { kind: 'batch', events: entry.pending.splice(0) });
        }

        const heartbeat = setInterval(() => {
            try {
                res.write(': ping\n\n');
            } catch { /* closed */ }
        }, 25000);

        const cleanup = () => {
            clearInterval(heartbeat);
            this.clients.delete(client);
            this.log(`tab detached — ${this.clients.size} tab(s)`);
            if (this.handlers.onClientCount) {
                this.handlers.onClientCount(this.clients.size);
            }
        };
        req.on('close', cleanup);
        req.on('error', cleanup);

        if (this.handlers.onClientCount) {
            this.handlers.onClientCount(this.clients.size);
        }
    }

    readJson(req, res, callback) {
        let body = '';
        let tooLarge = false;
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 64 * 1024 * 1024) {
                tooLarge = true;
                req.destroy();
            }
        });
        req.on('end', () => {
            if (tooLarge) {
                this.json(res, 413, { ok: false, error: 'payload too large' });
                return;
            }
            try {
                callback(body ? JSON.parse(body) : {});
            } catch (error) {
                this.log(`bad request body: ${error}`);
                this.json(res, 400, { ok: false, error: 'invalid json' });
            }
        });
    }

    json(res, status, payload) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
            .end(JSON.stringify(payload));
    }
}

module.exports = { ViewerServer, SERVER_CSP, withSavedCanvasData };
