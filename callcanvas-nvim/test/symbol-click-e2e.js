#!/usr/bin/env node
// Go to Declaration (Ctrl/⌘+click on a symbol-ref token) in a real browser: callcanvas host + headless chromium.
//
// Regression: the parameter types on a method's signature line (TypeRefs#make line 10: Shape / Size /
// List<Circle> / ShapeException) did not open their declaration while the body's Circle did.
// The click was decided on the `click` event, and the line's nodes were replaced between mousedown and
// mouseup (clearTextHighlight rewrote every line once a selection/search highlight had been applied —
// selectionchange of the click itself, 75 ms debounce) or the window moved under the pointer (hover
// transform): the click then landed on .code-line or was not fired at all.
//
// usage: node test/symbol-click-e2e.js        (needs chromium and java; about 30 s)
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'symbol-click');
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
const MOD = { Control: { bit: 2, code: 17 }, Meta: { bit: 4, code: 91 } };
const tokenCenter = (c, line, name) => c.evaluate(`(() => {
    const row = document.querySelector('.code-line-row[data-window-id="window-1"][data-line-number="${line}"]');
    const tk = row && [...row.querySelectorAll('.symbol-ref')].find(t => t.textContent === ${JSON.stringify(name)});
    if (!tk) return null;
    const r = tk.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, symbol: tk.dataset.symbol };
})()`);
const filePanel = c => c.evaluate(`(() => {
    const t = [...document.querySelectorAll('body > div')].find(d => d.style.position === 'fixed' && d.style.right === '0px'
        && d.style.display !== 'none' && d.querySelector('span'));
    if (!t) return null;
    const rows = [...t.querySelectorAll('div[style*="display:table-row"], div[style*="display: table-row"]')];
    const cur = rows.find(r => (r.getAttribute('style') || '').includes('#3a3d41'));
    return { title: t.querySelector('span').textContent, line: cur ? Number(cur.firstChild.textContent) : null,
        text: cur ? cur.lastChild.textContent : null };
})()`);
const hideFilePanel = c => c.evaluate(`[...document.querySelectorAll('body > div')]
    .filter(d => d.style.position === 'fixed' && d.style.right === '0px').forEach(d => { d.style.display = 'none'; }); true`);
const selectedCount = c => c.evaluate(`document.querySelectorAll('.code-window.selected').length`);
const mouse = (c, type, x, y, bit, extra = {}) => c.send('Input.dispatchMouseEvent', { type, x, y, modifiers: bit, ...extra });
const key = (c, mod, down) => c.send('Input.dispatchKeyEvent', { type: down ? 'rawKeyDown' : 'keyUp', key: mod,
    code: mod + 'Left', windowsVirtualKeyCode: MOD[mod].code, modifiers: down ? MOD[mod].bit : 0 });

/** Hold the modifier, hover (underline check), press, hold the button like a person (150 ms), release. */
async function modClick(c, mod, p, { hoverMs = 150, holdMs = 150 } = {}) {
    const bit = MOD[mod].bit;
    await key(c, mod, true);
    await mouse(c, 'mouseMoved', p.x, p.y, bit);
    await sleep(hoverMs);
    const style = await c.evaluate(`(() => { const el = document.elementFromPoint(${p.x}, ${p.y});
        const tk = el && el.closest('.symbol-ref'); if (!tk) return null; const cs = getComputedStyle(tk);
        return cs.textDecorationLine + '/' + cs.cursor; })()`);
    await mouse(c, 'mousePressed', p.x, p.y, bit, { button: 'left', clickCount: 1 });
    await sleep(holdMs);
    await mouse(c, 'mouseReleased', p.x, p.y, bit, { button: 'left', clickCount: 1 });
    await key(c, mod, false);
    return style;
}

async function expectPanel(c, label, symbols, symbolKey, name) {
    const want = symbols[symbolKey];
    let p = null;
    for (let i = 0; i < 20; i++) {
        await sleep(150);
        p = await filePanel(c);
        if (p && p.title === `${want.filePath}:${want.line}` && p.line === want.line) { break; }
    }
    check(`${label}: panel ${want.filePath}:${want.line}`,
        p && p.title === `${want.filePath}:${want.line}` && p.line === want.line && (p.text || '').includes(name), p);
}

const TOKENS = [[10, 'Shape'], [10, 'Size'], [10, 'Circle'], [10, 'ShapeException'], [11, 'Circle']];

(async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'callcanvas-symbol-click-'));
    const root = path.join(work, 'typerefs');
    let browser = null;
    let page = null;
    try {
        // project + saved canvas (Open Viewer reuses it: no analysis needed)
        fs.cpSync(FIXTURE, root, { recursive: true });
        const out = path.join(root, 'build', 'call-hierarchy-output');
        fs.mkdirSync(out, { recursive: true });
        fs.renameSync(path.join(root, 'canvas.json'), path.join(out, 'callcanvas_TypeRefs_make.json'));
        const symbols = JSON.parse(fs.readFileSync(path.join(out, 'callcanvas_TypeRefs_make.json'), 'utf8')).symbols;

        cli(['open', '--root', root, '--file', path.join(root, 'src/main/java/com/example/typerefs/TypeRefs.java'),
            '--line', '10', '--idle-timeout', '0']);
        let url = null;
        for (let i = 0; i < 30 && !url; i++) {
            const m = cli(['status', '--root', root]).match(/newest\s+(\S+)/);
            url = m && m[1];
            if (!url) { await sleep(300); }
        }
        check('host is serving the canvas', !!url);

        browser = await launchChromium(path.join(work, 'chromium'));
        page = await connect(browser.wsUrl);
        await page.send('Page.navigate', { url });
        await page.waitFor(`typeof currentData !== 'undefined' && currentData && document.querySelectorAll('.code-window#window-1 .symbol-ref').length > 0`, 60000);
        await sleep(1500);

        // 1) window not selected (mouse comes from outside: the hover transform is still running) / 2) selected
        for (const [mode, mod] of [['unselected', 'Control'], ['selected', 'Meta']]) {
            for (const [line, name] of TOKENS) {
                await hideFilePanel(page);
                await mouse(page, 'mouseMoved', 1550, 950, 0);
                await sleep(400);
                await page.evaluate(mode === 'selected' ? `selectWindow('window-1', false, false); true` : `clearSelection(); true`);
                const p = await tokenCenter(page, line, name);
                if (!p) { check(`${mode} ${line}:${name}: token rendered`, false); continue; }
                const before = await selectedCount(page);
                const style = await modClick(page, mod, p);
                const label = `${mode} ${mod}+click ${line}:${name}`;
                check(`${label}: underline + pointer while held`, style === 'underline/pointer', style);
                await expectPanel(page, label, symbols, p.symbol, name);
                check(`${label}: window selection unchanged`, (await selectedCount(page)) === before);
            }
        }

        // 3) after a selection highlight (double-click a word): the click collapses the selection and the
        //    highlight is cleared mid-click — this is what lost the signature line's clicks
        await hideFilePanel(page);
        const word = await tokenCenter(page, 11, 'Circle');
        for (const n of [1, 2]) {
            await mouse(page, 'mousePressed', word.x, word.y, 0, { button: 'left', clickCount: n });
            await mouse(page, 'mouseReleased', word.x, word.y, 0, { button: 'left', clickCount: n });
        }
        await sleep(400);
        check('double-click highlights the selected word',
            await page.evaluate(`document.querySelectorAll('#window-1 .selection-text-highlight').length > 0`));
        for (const [line, name] of TOKENS) {
            await hideFilePanel(page);
            const p = await tokenCenter(page, line, name);
            await modClick(page, 'Control', p);
            await expectPanel(page, `after selection highlight Ctrl+click ${line}:${name}`, symbols, p.symbol, name);
        }

        // 4) a plain click (no modifier) on a token still does not open anything
        await hideFilePanel(page);
        const plain = await tokenCenter(page, 10, 'Size');
        await mouse(page, 'mousePressed', plain.x, plain.y, 0, { button: 'left', clickCount: 1 });
        await mouse(page, 'mouseReleased', plain.x, plain.y, 0, { button: 'left', clickCount: 1 });
        await sleep(600);
        check('plain click on a token opens nothing', (await filePanel(page)) === null);
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
