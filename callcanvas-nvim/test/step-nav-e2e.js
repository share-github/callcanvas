#!/usr/bin/env node
// Step navigation (← / →) in a real browser: callcanvas host + headless chromium.
// Analyzes sample-project/sample-app-callorder (Flow#run) and checks that → walks the rows in execution order
// (arguments before the call, chains left to right, multi-line calls), lands back on the call row, ← retraces it,
// a clicked row resumes from there, and rapid presses are not lost while a window jump is in flight.
//
// usage: node test/step-nav-e2e.js        (needs chromium and java; about 30 s)
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const FIXTURE = path.join(__dirname, '..', '..', 'sample-project', 'sample-app-callorder');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cli = args => execFileSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 600000 });

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
    if (ok) { pass++; } else { fail++; }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`);
}

// --- minimal CDP driver (Node 22: global WebSocket / fetch) -------------------
async function launchChromium(dir) {
    const port = 9400 + Math.floor(Math.random() * 500);
    const proc = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
        `--user-data-dir=${dir}`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            const page = list.find(t => t.type === 'page');
            if (page) { return { proc, wsUrl: page.webSocketDebuggerUrl }; }
        } catch { /* not up yet */ }
        await sleep(100);
    }
    proc.kill('SIGKILL');
    throw new Error('chromium did not start');
}
async function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
            const { res, rej } = pending.get(m.id);
            pending.delete(m.id);
            if (m.error) { rej(new Error(JSON.stringify(m.error))); } else { res(m.result); }
        }
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async expr => {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) { throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); }
        return r.result.value;
    };
    const waitFor = async (expr, timeout) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) {
            try { if (await evaluate(expr)) { return; } } catch { /* page loading */ }
            await sleep(200);
        }
        throw new Error('timeout waiting for: ' + expr);
    };
    await send('Page.enable');
    await send('Runtime.enable');
    return { send, evaluate, waitFor, close: () => ws.close() };
}

// --- page helpers ---------------------------------------------------------------
const ARROW = { ArrowRight: 39, ArrowLeft: 37 };
async function press(c, k) {
    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: ARROW[k] });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: ARROW[k] });
}
/** "<displayName>:<line>" of the focused row, whether its window is the (only) selected one, and whether the window is on screen */
const where = c => c.evaluate(`(() => {
    const r = document.activeElement;
    if (!r || !r.classList.contains('code-line-row')) return null;
    const id = r.getAttribute('data-window-id');
    const w = currentData.windows.find(x => x.id === id);
    const el = document.getElementById(id);
    const b = el.getBoundingClientRect();
    const sel = [...document.querySelectorAll('.code-window.selected')].map(e => e.id);
    const ca = r.closest('.code-area').getBoundingClientRect();
    const rr = r.getBoundingClientRect();
    return { at: w.displayName + ':' + r.getAttribute('data-line-number'),
        rowInCodeArea: rr.top >= ca.top - 1 && rr.bottom <= ca.bottom + 1,
        selected: sel.length === 1 && sel[0] === id,
        onScreen: b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight };
})()`);
async function clickRow(c, name, line) {
    const locate = () => c.evaluate(`(() => {
        const w = currentData.windows.find(x => x.displayName === ${JSON.stringify(name)});
        const row = document.getElementById(w.id).querySelector('.code-line-row[data-line-number="${line}"]');
        const r = row.querySelector('.code-line').getBoundingClientRect();
        return { x: r.left + 40, y: r.top + r.height / 2 };
    })()`);
    await c.evaluate(`(() => { const w = currentData.windows.find(x => x.displayName === ${JSON.stringify(name)});
        document.getElementById(w.id).scrollIntoView({ block: 'center', inline: 'center' }); return true; })()`);
    await sleep(300);
    let p = await locate();
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await sleep(500);   // the window's hover transform settles under the pointer (else the click can land on a neighbour row)
    p = await locate();
    for (const type of ['mousePressed', 'mouseReleased']) {
        await c.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    }
    await sleep(300);
}

const RUN = 'Flow # run';
const EXPECTED = [
    `${RUN}:6`, `${RUN}:7`, 'Flow # inner:18', `${RUN}:7`, 'Flow # outer:19', `${RUN}:7`,
    `${RUN}:8`, 'Flow # first:20', `${RUN}:8`, 'Chain # second:4', `${RUN}:8`,
    `${RUN}:9`, 'Flow # a:21', `${RUN}:9`, 'Flow # b:22', `${RUN}:9`,
    `${RUN}:10`, 'Flow # arg:23', `${RUN}:11`, 'Flow # wrap:24', `${RUN}:10`,
    `${RUN}:13`, 'Flow # make:25', `${RUN}:13`, 'Chain # value:5', `${RUN}:13`, 'Chain # use:6', `${RUN}:13`,
    `${RUN}:14`, 'Flow # twice:26', `${RUN}:14`,
    // tall(): 40 rows, then a() near the bottom — landing back there scrolls inside the window
    `${RUN}:15`, 'Flow # tall:29', 'Flow # tall:30', ...Array.from({ length: 40 }, (_, i) => `Flow # tall:${31 + i}`),
    'Flow # tall:71', 'Flow # a:21', 'Flow # tall:71', 'Flow # tall:72', 'Flow # tall:73', `${RUN}:15`, `${RUN}:16`,
];

(async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'callcanvas-step-nav-'));
    const root = path.join(work, 'callorder');
    let browser = null;
    let page = null;
    try {
        fs.cpSync(path.join(FIXTURE, 'src'), path.join(root, 'src'), { recursive: true });
        fs.copyFileSync(path.join(FIXTURE, 'pom.xml'), path.join(root, 'pom.xml'));
        // the extension wants compiled classes (target/classes)
        const sources = fs.readdirSync(path.join(root, 'src/main/java/com/example/callorder')).map(f => path.join(root, 'src/main/java/com/example/callorder', f));
        execFileSync('javac', ['-d', path.join(root, 'target', 'classes'), ...sources]);
        cli(['open', '--root', root, '--file', path.join(root, 'src/main/java/com/example/callorder/Flow.java'),
            '--line', '6', '--idle-timeout', '0']);
        let url = null;
        for (let i = 0; i < 60 && !url; i++) {
            const m = cli(['status', '--root', root]).match(/newest\s+(\S+)/);
            url = m && m[1];
            if (!url) { await sleep(500); }
        }
        check('host is serving the canvas', !!url);

        browser = await launchChromium(path.join(work, 'chromium'));
        page = await connect(browser.wsUrl);
        await page.send('Page.navigate', { url });
        await page.waitFor(`typeof currentData !== 'undefined' && currentData && currentData.windows.length >= 12`, 60000);
        await sleep(1500);
        check('connections carry callEndCol',
            await page.evaluate(`currentData.connections.length > 0 && currentData.connections.every(c => typeof c.callEndCol === 'number')`));

        // → from the clicked signature row walks the whole canvas in execution order
        await clickRow(page, RUN, 6);
        const first = await where(page);
        check('click focuses the row', first && first.at === EXPECTED[0], first);
        const seen = [first && first.at];
        let allSelected = true;
        let allOnScreen = true;
        const rowHidden = [];
        for (let i = 1; i < EXPECTED.length; i++) {
            await press(page, 'ArrowRight');
            await sleep(350);
            const w = await where(page);
            seen.push(w && w.at);
            if (!w || !w.selected) allSelected = false;
            if (!w || !w.onScreen) allOnScreen = false;
            if (!w || !w.rowInCodeArea) rowHidden.push(w && w.at);
        }
        check('→ follows execution order', JSON.stringify(seen) === JSON.stringify(EXPECTED), seen);
        check('the focused row\'s window is the selected window at every step', allSelected);
        check('the window of every step is on screen', allOnScreen);
        check('the step row is scrolled into its window\'s code area', rowHidden.length === 0, rowHidden);
        await press(page, 'ArrowRight');
        await sleep(350);
        check('→ at the end stays on the last step', (await where(page))?.at === EXPECTED[EXPECTED.length - 1]);

        // ← retraces the same steps
        const back = [];
        for (let i = EXPECTED.length - 2; i >= 0; i--) {
            await press(page, 'ArrowLeft');
            await sleep(350);
            back.push((await where(page))?.at);
        }
        check('← retraces the steps', JSON.stringify(back) === JSON.stringify(EXPECTED.slice(0, -1).reverse()), back);

        // A clicked row resumes from there (a step row / a row inside a multi-line call)
        await clickRow(page, 'Flow # inner', 18);
        await press(page, 'ArrowRight');
        await sleep(350);
        check('→ from a clicked callee row returns to its caller row', (await where(page))?.at === `${RUN}:7`);
        await clickRow(page, RUN, 12);
        await press(page, 'ArrowRight');
        await sleep(350);
        check('→ from a row inside a multi-line call goes to the next row', (await where(page))?.at === `${RUN}:13`);

        // Rapid presses while window jumps are in flight are not lost
        await clickRow(page, RUN, 13);
        for (let i = 0; i < 3; i++) { await press(page, 'ArrowRight'); }
        await sleep(800);
        check('rapid → presses all count', (await where(page))?.at === 'Chain # value:5', await where(page));

        // Arrow keys typed in the search box do not step
        await page.evaluate(`showSearchBox(); document.getElementById('search-input').focus(); true`);
        await press(page, 'ArrowLeft');
        await sleep(300);
        check('← in the search box does not step', await page.evaluate(`document.activeElement.id === 'search-input'`));

        // Export HTML (IS_EXPORT_MODE: true) steps the same way: this page in export mode, opened as a file
        const html = await page.evaluate(`fetch(location.href).then(r => r.text())`);
        const origin = new URL(url).origin;
        const exportFile = path.join(work, 'export.html');
        fs.writeFileSync(exportFile, html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
            .replace('<head>', `<head><base href="${origin}/">`)
            .replace(/IS_EXPORT_MODE:\s*false/, 'IS_EXPORT_MODE: true'));
        await page.send('Page.navigate', { url: 'file://' + exportFile });
        await page.waitFor(`typeof IS_EXPORT_MODE !== 'undefined' && IS_EXPORT_MODE === true && currentData && document.querySelectorAll('.code-window').length >= 12`, 30000);
        await sleep(1000);
        await clickRow(page, RUN, 6);
        const exported = [];
        for (let i = 0; i < 5; i++) {
            await press(page, 'ArrowRight');
            await sleep(350);
            exported.push((await where(page))?.at);
        }
        check('export mode: → follows execution order', JSON.stringify(exported) === JSON.stringify(EXPECTED.slice(1, 6)), exported);
    } catch (e) {
        check('no exception', false, e.stack || String(e));
    } finally {
        if (page) { page.close(); }
        if (browser) { browser.proc.kill('SIGKILL'); }
        try { cli(['stop', '--root', root]); } catch { /* not running */ }
        await sleep(300);
        fs.rmSync(work, { recursive: true, force: true });
    }
    console.log(`\nPASS ${pass}, FAIL ${fail}`);
    process.exitCode = fail ? 1 : 0;
})();
