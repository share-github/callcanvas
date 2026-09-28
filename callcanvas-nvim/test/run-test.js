#!/usr/bin/env node
'use strict';
/**
 * Integration test for the Neovim host: starts a real host in-process, drives it
 * the way the browser does (POST /api/message + SSE) and checks what comes back.
 *
 *   node test/run-test.js [--keep]
 *
 * Requires java + the compiled extensions (`npm run compile` in each extension).
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const { CallCanvasHost, detectProjectRoot, persistentToken, canvasIdFor } = require('../src/host');
const { globToRegExp } = require('../src/vscodeShim');
const { ConfigStore, stripJsonComments } = require('../src/config');
const vm = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TARGET_FILE = process.env.CALLCANVAS_TEST_FILE
    || path.join(REPO_ROOT, 'sample-app/src/main/java/com/example/demo/service/TodoService.java');
const TARGET_LINE = Number(process.env.CALLCANVAS_TEST_LINE || 34);
// A second method in the same file — used to prove two canvases coexist.
const SECOND_LINE = Number(process.env.CALLCANVAS_TEST_LINE_2 || 90);

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
    if (condition) {
        passed++;
        console.log(`  PASS ${name}`);
    } else {
        failed++;
        console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

function section(title) {
    console.log(`\n=== ${title}`);
}

/** Minimal SSE client: collects events and lets a test wait for one. */
class EventStream {
    constructor(base, token, canvasId = '', follow = false) {
        this.events = [];
        this.waiters = [];
        this.canvasId = canvasId;
        const query = `t=${token}&c=${encodeURIComponent(canvasId)}&follow=${follow ? '1' : '0'}`;
        this.request = http.get(`${base}/api/events?${query}`, (res) => {
            res.setEncoding('utf8');
            let buffer = '';
            res.on('data', (chunk) => {
                buffer += chunk;
                let index;
                while ((index = buffer.indexOf('\n\n')) >= 0) {
                    const frame = buffer.slice(0, index);
                    buffer = buffer.slice(index + 2);
                    const line = frame.split('\n').find(l => l.startsWith('data: '));
                    if (!line) {
                        continue;
                    }
                    const payload = JSON.parse(line.slice(6));
                    const incoming = payload.kind === 'batch' ? (payload.events || []) : [payload];
                    for (const item of incoming) {
                        this.events.push(item);
                    }
                    for (const item of incoming) {
                        this.waiters = this.waiters.filter(w => {
                            if (w.match(item)) {
                                w.resolve(item);
                                return false;
                            }
                            return true;
                        });
                    }
                }
            });
        });
    }

    wait(match, timeoutMs = 180000) {
        const existing = this.events.find(match);
        if (existing) {
            return Promise.resolve(existing);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error('timed out waiting for an SSE event')),
                timeoutMs
            );
            this.waiters.push({
                match,
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                }
            });
        });
    }

    close() {
        this.request.destroy();
    }
}

function post(base, token, pathname, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request(`${base}${pathname}?t=${token}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

function get(base, pathname, headers) {
    return new Promise((resolve, reject) => {
        http.get(`${base}${pathname}`, { headers: headers || {} }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({
                status: res.statusCode,
                body: data,
                headers: res.headers
            }));
        }).on('error', reject);
    });
}

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function runCli(args) {
    return new Promise((resolve) => {
        execFile(process.execPath, [CLI, ...args], { timeout: 30000 }, (error, stdout) => {
            resolve(String(stdout || ''));
        });
    });
}

/**
 * Starting a second host for one project is refused on purpose, so make sure a
 * host left behind by an earlier test run is really gone before starting ours.
 */
async function stopExistingHost() {
    await runCli(['stop', '--file', TARGET_FILE]);
    for (let attempt = 0; attempt < 30; attempt++) {
        const status = await runCli(['status', '--file', TARGET_FILE, '--json']);
        if (status.includes('"running":false')) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    console.log('  WARN: a host is still running for this project');
}

function extractInitialData(html) {
    const match = html.match(/initialData: (\{[\s\S]*?\}),\n\s*jsonFilePath/);
    return match ? JSON.parse(match[1]) : null;
}

// --- unit-ish checks that need no host ------------------------------------
function testGlob() {
    section('glob translation (workspace.findFiles)');
    check('**/pom.xml matches a nested file', globToRegExp('**/pom.xml').test('a/b/pom.xml'));
    check('**/pom.xml matches a top-level file', globToRegExp('**/pom.xml').test('pom.xml'));
    check('**/pom.xml rejects a different name', !globToRegExp('**/pom.xml').test('a/pom.xml.bak'));
    check('**/node_modules/** matches inside', globToRegExp('**/node_modules/**').test('x/node_modules/y/z.js'));
    check('**/*.java matches by extension', globToRegExp('**/*.java').test('src/main/java/A.java'));
}

// --- configuration layering (.vscode/settings.json compatibility) ----------
function testConfig() {
    section('configuration: .vscode/settings.json is honoured');

    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cc-config-'));
    const repo = path.join(tmp, 'repo');
    const module_ = path.join(repo, 'moduleA');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.vscode'), { recursive: true });
    fs.mkdirSync(path.join(module_, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.vscode', 'settings.json'), JSON.stringify({
        'callcanvas.jumpToCallTargetKey': 'shift+b',
        'callcanvas.windowWidth': 600,
        'javaCallHierarchy.depth': 10
    }));
    // JSONC: comments and a trailing comma, plus a URL that must survive
    fs.writeFileSync(path.join(module_, '.vscode', 'settings.json'), `{
    // nearest file wins
    "callcanvas.windowWidth": 900, /* inline */
    "javaCallHierarchy.javaPath": "http://example.com//jdk",
}`);

    const store = new ConfigStore([], module_, {});
    const callcanvas = store.section('callcanvas');
    const java = store.section('javaCallHierarchy');
    check('ancestor .vscode/settings.json is read (repo root)',
        callcanvas.get('jumpToCallTargetKey', 'f12') === 'shift+b',
        callcanvas.get('jumpToCallTargetKey', 'f12'));
    check('the nearest .vscode/settings.json wins',
        callcanvas.get('windowWidth', 0) === 900, String(callcanvas.get('windowWidth', 0)));
    check('JSONC comments and trailing commas are tolerated',
        java.get('javaPath', '') === 'http://example.com//jdk', java.get('javaPath', ''));
    check('ancestor values still apply where the nearest file is silent',
        java.get('depth', 0) === 10, String(java.get('depth', 0)));

    const overridden = new ConfigStore([], module_, { 'callcanvas.windowWidth': 123 });
    check('--set overrides .vscode/settings.json',
        overridden.section('callcanvas').get('windowWidth', 0) === 123);

    check('a URL in a value is not mistaken for a comment',
        stripJsonComments('{"u": "http://a//b"}').includes('http://a//b'));

    fs.rmSync(tmp, { recursive: true, force: true });
}

// --- the browser-side bridge, run on a minimal DOM stub --------------------
function loadBridge(settings) {
    const handlers = [];
    let lastBadge = null;
    const calls = { jumpBack: 0, toasts: [], fetched: [] };
    const element = () => {
        const node = {
            style: {},
            children: [],
            textContent: '',
            listeners: {},
            setAttribute(name, value) {
                // Mirror the browser enough that reading node.style.* back works.
                if (name === 'style') {
                    String(value).split(';').forEach(decl => {
                        const [prop, val] = decl.split(':');
                        if (prop && val) { node.style[prop.trim()] = val.trim(); }
                    });
                }
            },
            appendChild(child) { node.children.push(child); return child; },
            removeChild() {},
            addEventListener(type, fn) { node.listeners[type] = fn; },
            click() {
                if (node.listeners.click) {
                    node.listeners.click({ preventDefault() {} });
                }
            },
            parentNode: null
        };
        return node;
    };

    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval: () => {},
        fetch: (u) => {
            calls.fetched.push(u);
            return Promise.resolve({ json: () => Promise.resolve({ canvases: [] }) });
        },
        EventSource: function () {
            this.close = () => {};
            this.readyState = 1;
        },
        sessionStorage: { getItem: () => null, setItem: () => {} },
        location: { reload: () => {} },
        document: {
            readyState: 'complete',
            addEventListener: (type, fn, capture) => handlers.push({ type, fn, capture }),
            createElement: element,
            createTextNode: (text) => ({ text }),
            documentElement: { appendChild(node) { lastBadge = node; return node; } },
            body: { appendChild(node) { lastBadge = node; return node; } },
            getElementById: () => null
        }
    };
    sandbox.window = sandbox;
    sandbox.__CALLCANVAS_BRIDGE__ = {
        token: 't', canvasId: 'c1', follow: true, permalink: 'p', listUrl: 'l', settings
    };
    sandbox.jumpBack = () => { calls.jumpBack++; };
    sandbox.showToast = (text) => { calls.toasts.push(text); };
    sandbox.addEventListener = () => {};

    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'bridge.client.js'), 'utf8'), sandbox);

    const keydown = handlers.find(h => h.type === 'keydown');
    /** Click every element that has a click handler (the switcher toggle). */
    const clickAll = (node, depth = 0) => {
        if (!node || depth > 4) { return; }
        if (node.listeners && node.listeners.click) { node.click(); }
        (node.children || []).forEach(child => clickAll(child, depth + 1));
    };
    const press = (event) => {
        let prevented = false;
        keydown.fn(Object.assign({
            target: { tagName: 'BODY' },
            preventDefault: () => { prevented = true; },
            stopPropagation: () => {}
        }, event));
        return prevented;
    };
    return { sandbox, calls, keydown, press, clickAll, badge: () => lastBadge };
}

function testBridgeKeys() {
    section('browser bridge: jump-back key (alt+left conflicts with the browser)');

    const bridge = loadBridge({ jumpBackKey: 'shift+o', interceptBrowserBack: true });
    check('the bridge registers a keydown handler in capture phase',
        !!bridge.keydown && bridge.keydown.capture === true);
    check('viewer.js keeps owning the vscode API surface',
        typeof bridge.sandbox.acquireVsCodeApi === 'function');
    bridge.clickAll(bridge.badge());
    check('opening the canvas switcher asks the host for the canvas list',
        bridge.calls.fetched.some(u => String(u).startsWith('/api/canvases')),
        bridge.calls.fetched.join(' '));

    let prevented = bridge.press({ key: 'O', shiftKey: true });
    check('shift+o calls jumpBack()', bridge.calls.jumpBack === 1);
    check('shift+o is prevented from reaching the page', prevented === true);

    prevented = bridge.press({ key: 'ArrowLeft', altKey: true });
    check('alt+left still works (VS Code parity)', bridge.calls.jumpBack === 2);
    check('alt+left no longer navigates the browser back', prevented === true);

    bridge.press({ key: 'ArrowLeft', metaKey: true });
    check('cmd+left (macOS Back) is intercepted too', bridge.calls.jumpBack === 3);

    bridge.press({ key: 'x' });
    check('an unrelated key is ignored', bridge.calls.jumpBack === 3);

    bridge.press({ key: 'O', shiftKey: true, target: { tagName: 'TEXTAREA' } });
    check('typing in a textarea is not hijacked', bridge.calls.jumpBack === 3);
    bridge.press({ key: 'O', shiftKey: true, target: { tagName: 'DIV', isContentEditable: true } });
    check('contenteditable is not hijacked', bridge.calls.jumpBack === 3);

    const custom = loadBridge({ jumpBackKey: 'shift+u', interceptBrowserBack: false });
    custom.press({ key: 'U', shiftKey: true });
    check('a configured key is honoured', custom.calls.jumpBack === 1);
    const notPrevented = custom.press({ key: 'ArrowLeft', altKey: true });
    check('interceptBrowserBack=false leaves the browser Back alone',
        custom.calls.jumpBack === 1 && notPrevented === false);
}

async function main() {
    testGlob();
    testConfig();
    testBridgeKeys();

    if (!fs.existsSync(TARGET_FILE)) {
        console.log(`\nSKIP host tests: ${TARGET_FILE} not found`);
        return;
    }

    section('start the host');
    await stopExistingHost();
    const projectRoot = detectProjectRoot(TARGET_FILE);
    console.log(`  project root: ${projectRoot}`);
    const host = new CallCanvasHost({
        projectRoot,
        nvimAddress: null,
        bindHost: '127.0.0.1',
        port: 0,
        idleTimeoutMs: 0,
        settings: {},
        verbose: !!process.env.CALLCANVAS_TEST_VERBOSE
    });
    const listening = await host.start();
    const base = `http://127.0.0.1:${listening.port}`;
    const token = listening.token;
    check('extensions activated', host.activation.activated.length === 4,
        `activated=${host.activation.activated.length} missing=${host.activation.missing.join(',')}`);

    let stream;
    try {
        section(`analyze ${path.basename(TARGET_FILE)}:${TARGET_LINE} from the caret`);
        const opened = await host.open({ file: TARGET_FILE, line: TARGET_LINE });
        check('open() succeeded', opened.ok === true, opened.error);

        const page = await get(base, `/?t=${token}`);
        check('page served', page.status === 200);
        const data = extractInitialData(page.body);
        check('canvas has windows', !!data && data.windows.length > 1,
            data ? `windows=${data.windows.length}` : 'no initialData');
        check('bridge injected before viewer.js',
            page.body.indexOf('bridge.js') < page.body.indexOf('viewer.js'));
        check('webview CSP replaced with a server-mode CSP',
            page.body.includes("connect-src 'self'"));
        check('assets are routed through the host',
            page.body.includes('/asset?t='));
        // The repo's .vscode/settings.json sets this; the viewer page must carry it.
        const configuredKey = new ConfigStore([], projectRoot, {})
            .section('callcanvas').get('jumpToCallTargetKey', 'f12');
        check('the page carries the configured jump key',
            page.body.includes(`jumpToCallTargetKey: ${JSON.stringify(configuredKey)}`),
            configuredKey);
        check('the page carries a browser-safe jump-back key',
            /"jumpBackKey":"[^"]+"/.test(page.body) && !/"jumpBackKey":"alt\+left"/.test(page.body),
            (page.body.match(/"jumpBackKey":"[^"]+"/) || [''])[0]);

        const rootWindow = data.windows[0];
        check('root window is the analyzed method',
            rootWindow.displayName.replace(/\s+/g, '').includes('TodoService#search'),
            rootWindow.displayName);

        section('a caret with no method is reported as an error');
        const noMethod = await host.open({ file: TARGET_FILE, line: 1 });
        check('open() on the package declaration fails',
            noMethod.ok === false && /cursor position/i.test(noMethod.error || ''),
            JSON.stringify(noMethod));
        const stillServed = await get(base, `/?t=${token}`);
        check('the previous canvas is still served', stillServed.status === 200);

        section('token / path guards');
        check('bad token rejected', (await get(base, '/?t=nope')).status === 403);
        check('asset outside the extension dirs rejected',
            (await get(base, `/asset?t=${token}&p=${encodeURIComponent('/etc/passwd')}`)).status === 403);

        section('browser -> host: postMessage bridge');
        const firstCanvasId = opened.canvasId;
        check('open() reports a canvas id', !!firstCanvasId, JSON.stringify(opened));
        stream = new EventStream(base, token, firstCanvasId, true);
        await new Promise(resolve => setTimeout(resolve, 300));

        // Width dialog: host asks the browser, browser answers, host applies.
        const widthUi = stream.wait(e => e.kind === 'ui' && e.type === 'input');
        await post(base, token, '/api/message', {
            message: { command: 'showWidthInputDialog', currentWidth: 600 },
            canvasId: firstCanvasId
        });
        const uiEvent = await widthUi;
        check('host asked the browser for a width', uiEvent.type === 'input');
        const applied = stream.wait(e => e.kind === 'post' && e.message.command === 'applyWidth');
        await post(base, token, '/api/ui-reply', { id: uiEvent.id, value: '820' });
        const appliedEvent = await applied;
        check('width came back to the canvas', appliedEvent.message.width === 820,
            JSON.stringify(appliedEvent.message));

        // Next-level analysis: browser asks, the JAR runs, the result is merged back.
        // `code` is a plain string in CLI output and an array of {line, content}
        // once the viewer has normalised it — accept both.
        const codeText = (w) => (Array.isArray(w.code)
            ? w.code.map(l => l.content).join('\n')
            : String(w.code || ''));
        const codeStart = (w) => (Array.isArray(w.code) && w.code.length > 0
            ? w.code[0].line
            : (w.startLine || 1));
        const callee = data.windows.find(w => w.id !== rootWindow.id
            && w.filePath && w.filePath.endsWith('.java')
            && codeText(w).length > 0);
        if (callee) {
            const merged = stream.wait(e => e.kind === 'post' && e.message.command === 'mergeCallCanvasData');
            await post(base, token, '/api/message', {
                canvasId: firstCanvasId,
                message: {
                    command: 'analyzeNextLevel',
                    windowData: {
                        id: callee.id,
                        displayName: callee.displayName,
                        filePath: callee.filePath,
                        code: codeText(callee),
                        startLine: codeStart(callee)
                    }
                }
            });
            const mergedEvent = await merged;
            check('analyzeNextLevel merged new windows',
                !!mergedEvent.message.data && mergedEvent.message.data.windows.length > 0,
                `target=${callee.displayName}`);
        } else {
            check('analyzeNextLevel target found', false, 'no callee window with code');
        }

        // saveData writes the canvas JSON the viewer was opened from.
        section('the first visit uses a short, typable URL');
        const shortUrl = opened.shortUrl;
        check('open() returns a short unlock URL', !!shortUrl, String(shortUrl));
        check('it is short enough to type', shortUrl.length <= 50, `${shortUrl} (${shortUrl.length})`);
        check('it is much shorter than the tokened permalink',
            shortUrl.length < opened.permalink.length - 20,
            `${shortUrl.length} vs ${opened.permalink.length}`);
        const unlockPath = new (require('url').URL)(shortUrl).pathname;
        const unlocked = await get(base, unlockPath);
        check('it redirects to its canvas',
            unlocked.status === 302 && unlocked.headers.location === `/c/${opened.canvasId}`,
            `${unlocked.status} -> ${unlocked.headers.location}`);
        const setCookie = String(unlocked.headers['set-cookie'] || '');
        check('it sets the auth cookie', /cc_token=/.test(setCookie) && /HttpOnly/.test(setCookie));
        // Reusable on purpose: browsers prefetch address-bar URLs, and people paste
        // a link they copied earlier.
        check('the same link still works on a second visit',
            (await get(base, unlockPath)).status === 302);
        check('the short link identifies this canvas (so a new tab is a 2nd canvas)',
            unlockPath.endsWith('/' + opened.canvasId), unlockPath);
        const reMinted = (await post(base, token, '/api/open', { file: TARGET_FILE, line: TARGET_LINE })).body;
        check('re-analysing the same canvas keeps the same link',
            reMinted.shortUrl === shortUrl, `${shortUrl} vs ${reMinted.shortUrl}`);
        check('a wrong key is rejected', (await get(base, '/k/deadbeef')).status === 403);
        check('an already-authorised browser is let through a stale link',
            (await get(base, '/k/deadbeef', { Cookie: `cc_token=${token}` })).status === 302);

        section('the URL stays bookmarkable (no copying on later runs)');
        check('token is persisted per project', persistentToken(projectRoot) === token);
        const pageAgain = await get(base, `/?t=${token}`);
        check('page sets the auth cookie',
            /cc_token=/.test(String(pageAgain.headers['set-cookie'] || '')),
            String(pageAgain.headers['set-cookie']));
        const viaCookie = await get(base, '/', { Cookie: `cc_token=${token}` });
        check('bare / works with the cookie', viaCookie.status === 200, `status=${viaCookie.status}`);
        const noAuth = await get(base, '/');
        check('bare / without the cookie is rejected', noAuth.status === 403, `status=${noAuth.status}`);
        const wrongCookie = await get(base, '/', { Cookie: 'cc_token=nope' });
        check('bare / with a wrong cookie is rejected', wrongCookie.status === 403);
        const assetCookieOnly = await get(base,
            `/asset?p=${encodeURIComponent(path.join(REPO_ROOT, 'vscode-callcanvas-viewer/media/viewer.css'))}`,
            { Cookie: `cc_token=${token}` });
        check('the cookie does not unlock non-page routes', assetCookieOnly.status === 403);

        section('re-analysing the same canvas refreshes it in place');
        const pinned = new EventStream(base, token, firstCanvasId, false);
        await new Promise(resolve => setTimeout(resolve, 200));
        const reloadedPinned = pinned.wait(e => e.kind === 'navigate');
        const reopened = await host.open({ file: TARGET_FILE, line: TARGET_LINE });
        check('same canvas id is reused', reopened.canvasId === firstCanvasId,
            `${firstCanvasId} -> ${reopened.canvasId}`);
        check('still a single canvas', reopened.canvasCount === 1, `count=${reopened.canvasCount}`);
        check('open() reports the attached tabs', reopened.clients >= 1, `clients=${reopened.clients}`);
        await reloadedPinned;
        check('the pinned tab was told to reload', true);

        section('a different method opens a SECOND canvas (both stay open)');
        const followNavigate = stream.wait(e => e.kind === 'navigate');
        const second = await host.open({ file: TARGET_FILE, line: SECOND_LINE });
        check('second open() succeeded', second.ok === true, second.error);
        check('a new canvas id was created', !!second.canvasId && second.canvasId !== firstCanvasId,
            `${firstCanvasId} vs ${second.canvasId}`);
        check('two canvases are open', second.canvasCount === 2, `count=${second.canvasCount}`);
        await followNavigate;
        check('the following tab (/) was told to reload', true);

        check('the second canvas has its own short link',
            !!second.shortUrl && second.shortUrl !== opened.shortUrl,
            `${opened.shortUrl} vs ${second.shortUrl}`);
        const secondUnlock = new (require('url').URL)(second.shortUrl).pathname;
        const landed = await get(base, secondUnlock);
        check('its short link redirects straight to that canvas',
            landed.status === 302 && landed.headers.location === `/c/${second.canvasId}`,
            `${landed.status} -> ${landed.headers.location}`);
        check('a pinned tab was told a new canvas appeared',
            pinned.events.some(e => e.kind === 'canvas-added' && e.id === second.canvasId),
            pinned.events.map(e => e.kind).join(','));

        const listing = await get(base, `/api/canvases?t=${token}`);
        const summaries = JSON.parse(listing.body).canvases;
        check('both canvases are listed', summaries.length === 2,
            summaries.map(c => c.title).join(' , '));
        check('the newest canvas is flagged',
            summaries.filter(c => c.latest).length === 1 && summaries.find(c => c.latest).id === second.canvasId);

        const firstPage = await get(base, `/c/${firstCanvasId}?t=${token}`);
        const secondPage = await get(base, `/c/${second.canvasId}?t=${token}`);
        check('the first canvas is still served at its permalink', firstPage.status === 200);
        check('the second canvas is served at its own permalink', secondPage.status === 200);
        const firstData = extractInitialData(firstPage.body);
        const secondData = extractInitialData(secondPage.body);
        check('the two permalinks show different canvases',
            !!firstData && !!secondData
            && firstData.windows[0].displayName !== secondData.windows[0].displayName,
            `${firstData && firstData.windows[0].displayName} / ${secondData && secondData.windows[0].displayName}`);
        check('/ shows the newest canvas',
            extractInitialData((await get(base, `/?t=${token}`)).body).windows[0].displayName
                === secondData.windows[0].displayName);
        check('canvas ids are derived from the JSON path (stable permalinks)',
            summaries.every(c => c.id === canvasIdFor(c.jsonPath)));
        check('the canvas list page renders',
            (await get(base, `/canvases?t=${token}`)).status === 200);
        check('every listed canvas carries a short link',
            summaries.every(c => /\/k\/[0-9a-f]+\//.test(c.shortUrl)),
            summaries.map(c => c.shortUrl).join(' '));
        check('an unknown canvas id 404s',
            (await get(base, `/c/deadbeef?t=${token}`)).status === 404);

        section('messages are routed to the right canvas');
        const secondStream = new EventStream(base, token, second.canvasId, false);
        await new Promise(resolve => setTimeout(resolve, 200));
        const secondWidth = secondStream.wait(e => e.kind === 'ui');
        await post(base, token, '/api/message', {
            canvasId: second.canvasId,
            message: { command: 'showWidthInputDialog', currentWidth: 300 }
        });
        const secondUi = await secondWidth;
        const appliedToSecond = secondStream.wait(e => e.kind === 'post' && e.message.command === 'applyWidth');
        await post(base, token, '/api/ui-reply', { id: secondUi.id, value: '640' });
        const secondApplied = await appliedToSecond;
        check('the second canvas got its own applyWidth', secondApplied.message.width === 640);
        check('the first canvas did not receive it',
            !pinned.events.some(e => e.kind === 'post' && e.message.command === 'applyWidth' && e.message.width === 640));
        secondStream.close();
        pinned.close();

        section('saveData writes back to disk');
        const jsonPath = firstPage.body.match(/jsonFilePath: "([^"]*)"/)[1];
        check('json path resolved', !!jsonPath && fs.existsSync(jsonPath), jsonPath);
        const before = fs.readFileSync(jsonPath, 'utf8');
        const marked = JSON.parse(before);
        marked.windows[0].comment = 'callcanvas-nvim test marker';
        await post(base, token, '/api/message', {
            canvasId: firstCanvasId,
            message: { command: 'saveData', data: marked }
        });
        await new Promise(resolve => setTimeout(resolve, 400));
        const after = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        check('canvas JSON updated', after.windows[0].comment === 'callcanvas-nvim test marker');
        fs.writeFileSync(jsonPath, before, 'utf8');
    } finally {
        if (stream) {
            stream.close();
        }
        await host.server.close();
        host.clearSession();
    }
}

main().then(() => {
    console.log('\n----------------------------------------');
    console.log(`PASS: ${passed}  FAIL: ${failed}`);
    process.exit(failed === 0 ? 0 : 1);
}).catch((error) => {
    console.error('\nFATAL', error && error.stack ? error.stack : error);
    process.exit(1);
});
