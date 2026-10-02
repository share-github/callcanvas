#!/usr/bin/env node
// Step navigation (← / →) on a real change set canvas: sample-project/sample-changeset-demo (commit 93b7cd56, copied to a
// temp dir so the user's saved canvas is untouched) → callcanvas changeset → headless chromium.
// Regression: the windows directly under the Java block (AppConfig.java, OrderService.java, legacyDiscount（削除）,
// PaymentServiceTest.java) are laid out after the block's islands, but the steps put them first (groups order), so → from
// island 6 jumped to clientside and they were unreachable. Also: → walks every window and ← retraces every step, and
// holding → / ← (key repeat faster than a window jump's delayed focus) does not loop (was: render ⇄ send).
//
// usage: node test/step-nav-changeset-e2e.js     (needs chromium, java and git; about 3 min)
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const DEMO = path.join(__dirname, '..', '..', 'sample-project', 'sample-changeset-demo', 'repo');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cli = args => execFileSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 600000 });
let pass = 0, fail = 0;
function check(name, ok, detail) { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); }
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


const ARROW = { ArrowRight: 39, ArrowLeft: 37 };
async function press(c, k) {
    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: ARROW[k] });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: ARROW[k] });
}
// after a key: wait until the focused row is the step (jump finished); returns {id, name, line, same}
async function settle(c) {
    for (let i = 0; i < 100; i++) {
        const r = await c.evaluate(`(() => {
            const a = document.activeElement;
            if (stepJumpPending || !stepExpect || !a || !a.classList.contains('code-line-row')) return null;
            if (a.getAttribute('data-window-id') !== stepExpect.windowId) return null;
            const w = currentData.windows.find(x => x.id === stepExpect.windowId);
            return { id: w.id, name: w.displayName, line: Number(a.getAttribute('data-line-number')), want: stepExpect.line };
        })()`);
        if (r) return r;
        await sleep(30);
    }
    return null;
}
async function clickRow(c, name, line) {
    const locate = () => c.evaluate(`(() => {
        const w = currentData.windows.find(x => x.displayName === ${JSON.stringify(name)});
        const el = document.getElementById(w.id);
        const rows = [...el.querySelectorAll('.code-line-row')];
        const row = ${line === 'last' ? 'rows[rows.length - 1]' : `el.querySelector('.code-line-row[data-line-number="${line}"]')`};
        const r = row.querySelector('.code-line').getBoundingClientRect();
        return { x: r.left + 40, y: r.top + r.height / 2, line: Number(row.getAttribute('data-line-number')) };
    })()`);
    await c.evaluate(`(() => { const w = currentData.windows.find(x => x.displayName === ${JSON.stringify(name)});
        document.getElementById(w.id).scrollIntoView({ block: 'center', inline: 'center' }); return true; })()`);
    await sleep(300);
    let p = await locate();
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await sleep(500);   // the window's hover transform settles under the pointer
    p = await locate();
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(300);
    const f = await focused(c);
    check(`click focuses ${name}:${p.line}`, f === `${name}:${p.line}`, f);
    return p.line;
}
const focused = c => c.evaluate(`(() => { const a = document.activeElement; if (!a || !a.classList.contains('code-line-row')) return null;
    const w = currentData.windows.find(x => x.id === a.getAttribute('data-window-id')); return w.displayName + ':' + a.getAttribute('data-line-number'); })()`);

(async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-demo-'));
    const root = path.join(work, 'repo');
    let browser = null, page = null;
    try {
        execFileSync('cp', ['-a', DEMO, root]);
        fs.rmSync(path.join(root, 'build', 'call-hierarchy-output'), { recursive: true, force: true });
        const out = cli(['changeset', '93b7cd56', '--root', root, '--file', path.join(root, 'src/main/java/com/example/demo/order/OrderService.java'), '--idle-timeout', '0', '--json']);
        check('changeset canvas opened', JSON.parse(out).ok === true, out.trim().slice(0, 200));
        let url = null;
        for (let i = 0; i < 60 && !url; i++) { const m = cli(['status', '--root', root]).match(/newest\s+(\S+)/); url = m && m[1]; if (!url) await sleep(500); }
        browser = await launchChromium(path.join(work, 'chromium'));
        page = await connect(browser.wsUrl);
        await page.send('Page.navigate', { url });
        await page.waitFor(`typeof currentData !== 'undefined' && currentData && currentData.windows.length > 20`, 60000);
        await sleep(2000);
        const names = await page.evaluate(`currentData.windows.map(w => w.displayName)`);

        // 1) the reported scenario: last row of island 6 → next is AppConfig.java; then the other three by →
        const last = await clickRow(page, 'ShippingService # schedule', 'last');
        const reach = [];
        for (let i = 0; i < 80; i++) {
            await press(page, 'ArrowRight');
            const s = await settle(page);
            reach.push(s && s.name + ':' + s.line);
            if (s && s.name === 'app # init') break;
        }
        const firstOf = n => reach.findIndex(x => x && x.startsWith(n + ':'));
        const four = ['AppConfig.java', 'OrderService.java', 'OrderService # legacyDiscount（削除）', 'PaymentServiceTest.java'];
        check('→ from the end of island 6 goes to AppConfig.java', reach[0] && reach[0].startsWith('AppConfig.java:'), reach.slice(0, 3));
        check('→ then visits the 4 Java file windows in screen order, then clientside',
            four.every(n => firstOf(n) >= 0) && four.every((n, i) => i === 0 || firstOf(n) > firstOf(four[i - 1])) && firstOf('app # init') > firstOf(four[3]),
            four.map(firstOf));
        console.log('  path:', reach.join(' → '));

        // 2) ← from AppConfig's first step goes back to the end of island 6
        await clickRow(page, 'AppConfig.java', Number(reach[0].split(':').pop()));
        await press(page, 'ArrowLeft');
        const b = await settle(page);
        check('← from AppConfig.java goes back to ShippingService # schedule', b && b.name === 'ShippingService # schedule', b);

        // 4) held keys (key repeat): steps that change windows faster than a jump's delayed focus (100 ms) must not
        //    loop (regression: InvoiceRenderer # render ⇄ InvoiceMailer # send) — → and ← at several repeat rates
        const startName = await page.evaluate(`currentData.windows.find(w => w.id === buildStepModel(currentData).starts[0]).displayName`);
        const startLine = await page.evaluate(`buildStepModel(currentData).groups.get(buildStepModel(currentData).starts[0])[0].line`);
        const N = 60;
        for (const gap of [10, 30, 60, 110]) {
            await clickRow(page, startName, startLine);
            const path = await page.evaluate(`(() => { const m = buildStepModel(currentData); const a = document.activeElement;
                let s = stepStateFromRow(m, null, a.getAttribute('data-window-id'), Number(a.getAttribute('data-line-number')));
                const out = []; for (let i = 0; i < ${N}; i++) { s = stepNext(m, s); const p = stepPosition(m, s);
                  out.push(currentData.windows.find(w => w.id === p.windowId).displayName + ':' + p.line); } return out; })()`);
            for (let i = 0; i < N; i++) { await press(page, 'ArrowRight'); await sleep(gap); }
            await sleep(1200);
            const fwdAt = await focused(page);
            check(`held → (${N} × ${gap} ms) ends on step ${N}`, fwdAt === path[N - 1], { got: fwdAt, want: path[N - 1] });
            for (let i = 0; i < N; i++) { await press(page, 'ArrowLeft'); await sleep(gap); }
            await sleep(1200);
            const backAt = await focused(page);
            check(`held ← (${N} × ${gap} ms) comes back to the start`, backAt === `${startName}:${startLine}`, backAt);
        }

        // 3) the whole canvas: → from the first step to the end visits every window; ← retraces it
        await page.evaluate(`document.activeElement && document.activeElement.blur(); clearSelection(); stepState = null; stepExpect = null; true`);
        const fwd = [];
        for (let i = 0; i < 2000; i++) {
            const before = await page.evaluate(`stepState`);
            await press(page, 'ArrowRight');
            const s = await settle(page);
            const after = await page.evaluate(`stepState`);
            if (JSON.stringify(before) === JSON.stringify(after)) break;
            fwd.push(s ? s.id + ':' + s.line : 'NOFOCUS');
        }
        const visited = new Set(fwd.map(x => x.split(':')[0]));
        const ids = await page.evaluate(`currentData.windows.map(w => w.id)`);
        check(`→ walks every window (${fwd.length} steps)`, ids.every(id => visited.has(id)), ids.filter(id => !visited.has(id)));
        check('every step focused its row', !fwd.includes('NOFOCUS'));
        const back = [];
        for (let i = 0; i < fwd.length - 1; i++) { await press(page, 'ArrowLeft'); const s = await settle(page); back.push(s ? s.id + ':' + s.line : 'NOFOCUS'); }
        check('← retraces every step', JSON.stringify(back) === JSON.stringify(fwd.slice(0, -1).reverse()));
        const order = [];
        for (const x of fwd) { const id = x.split(':')[0]; if (!order.includes(id)) order.push(id); }
        const byId = new Map((await page.evaluate(`currentData.windows.map(w => [w.id, w.displayName])`)));
        console.log('  window order:', order.map(id => byId.get(id)).join(' → '));
    } catch (e) {
        check('no exception', false, e.stack || String(e));
    } finally {
        if (page) page.close();
        if (browser) browser.proc.kill('SIGKILL');
        try { cli(['stop', '--root', root]); } catch {}
        await sleep(300);
        fs.rmSync(work, { recursive: true, force: true });
    }
    console.log(`\nPASS ${pass}, FAIL ${fail}`);
    process.exitCode = fail ? 1 : 0;
})();
