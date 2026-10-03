#!/usr/bin/env node
// Live change set in a real browser: callcanvas host + headless chromium.
// `callcanvas changeset live` opens an empty canvas whose badge says LIVE; edits + `callcanvas notify` (what the
// Claude Code hook runs) make the badge offer the rebuild without touching the canvas; clicking 取り込む reloads
// the tab with it. A commit change set's badge offers ライブ追従を開始, which moves the tab to the live canvas.
//
// usage: node test/live-changeset-e2e.js [screenshot-dir]   (needs chromium and java; about 1 min)
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChangeSetFixture } = require('./changeset-fixture');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
    if (ok) { pass++; } else { fail++; }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`);
}

// --- minimal CDP driver (Node 22: global WebSocket / fetch), as in step-nav-e2e.js ----------
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
            try { if (await evaluate(expr)) { return true; } } catch { /* page loading */ }
            await sleep(200);
        }
        return false;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    return { send, evaluate, waitFor, close: () => ws.close() };
}

/** The text of the badge's live line ('' when hidden). */
const LIVE_TEXT = `(() => { const a = [...document.querySelectorAll('a')].find(x => /取り込む|ライブ追従を開始/.test(x.textContent));
    const row = a ? a.parentNode : [...document.querySelectorAll('div')].find(d => /^● LIVE/.test(d.textContent || ''));
    return row ? row.textContent : ''; })()`;
const clickLink = (c, text) => c.evaluate(`(() => { const a = [...document.querySelectorAll('a')].find(x => x.textContent === ${JSON.stringify(text)});
    if (!a) return false; a.click(); return true; })()`);
const windowNames = c => c.evaluate('currentData.windows.map(w => w.displayName)');

(async () => {
    const shots = process.argv[2] ? path.resolve(process.argv[2]) : null;
    if (shots) { fs.mkdirSync(shots, { recursive: true }); }
    let fixture = null;
    let browser = null;
    let page = null;
    try {
        fixture = createChangeSetFixture();
        const repo = fixture.repo;
        // The host looks for the Claude Code hook in $CLAUDE_CONFIG_DIR/settings.json: none at first.
        const claudeDir = path.join(fixture.workDir, 'claude');
        fs.mkdirSync(claudeDir, { recursive: true });
        const env = Object.assign({}, process.env, fixture.env, { CLAUDE_CONFIG_DIR: claudeDir });
        const cli = args => execFileSync('node', [CLI, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 600000 });
        const shot = async (c, name) => {
            if (!shots) { return; }
            const r = await c.send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, 'base64'));
        };

        const live = JSON.parse(cli(['changeset', 'live', '--json']).trim().split('\n').pop());
        browser = await launchChromium(fs.mkdtempSync(path.join(os.tmpdir(), 'callcanvas-live-chrome-')));
        page = await connect(browser.wsUrl);
        await page.send('Page.navigate', { url: live.permalink });
        check('the live canvas loads with a LIVE badge',
            await page.waitFor(`typeof currentData === 'object' && /● LIVE/.test(${LIVE_TEXT})`, 30000), await page.evaluate(LIVE_TEXT).catch(() => ''));
        check('without the Claude Code hook the badge says it will not follow (not "up to date")',
            await page.waitFor(`/hook が未設定/.test(${LIVE_TEXT}) && !/最新/.test(${LIVE_TEXT})`, 60000), await page.evaluate(LIVE_TEXT));
        await shot(page, '0-live-no-hook.png');
        cli(['install-hook', '--settings', path.join(claudeDir, 'settings.json')]);
        await page.send('Page.reload');
        check('... 0 files, up to date once the hook is installed',
            await page.waitFor(`typeof currentData === 'object' && /0 ファイル . 0 島/.test(${LIVE_TEXT}) && /最新/.test(${LIVE_TEXT})
                && !/hook が未設定/.test(${LIVE_TEXT})`, 60000) && (await windowNames(page)).length === 0,
            await page.evaluate(LIVE_TEXT));
        await shot(page, '1-live-empty.png');

        // The AI edits (a method, a new class, a note) and the hook runs notify
        const service = path.join(repo, 'src/main/java/com/example/changeset/order/OrderService.java');
        const text = fs.readFileSync(service, 'utf8');
        const end = text.lastIndexOf('}');
        fs.writeFileSync(service, text.slice(0, end) + '\n    public int liveProbe() {\n        return changeSetProbe() + 1;\n    }\n' + text.slice(end));
        fs.writeFileSync(path.join(repo, 'src/main/java/com/example/changeset/order/LiveHelper.java'),
            'package com.example.changeset.order;\n\npublic class LiveHelper {\n    public int help(OrderService s) {\n        return s.liveProbe();\n    }\n}\n');
        fs.mkdirSync(path.join(repo, 'notes'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'notes/live.md'), '# live\n');
        cli(['notify']);

        check('the badge offers the rebuild (更新あり 3 ファイル + 取り込む)',
            await page.waitFor(`/更新あり（3 ファイル/.test(${LIVE_TEXT}) && /取り込む/.test(${LIVE_TEXT})`, 300000), await page.evaluate(LIVE_TEXT));
        check('... without changing the canvas under the reader', (await windowNames(page)).length === 0);
        await shot(page, '2-live-pending.png');

        await page.evaluate('window.__beforeTakeIn = true');
        check('clicking 取り込む works', await clickLink(page, '取り込む'));
        check('the tab reloads with the rebuild',
            await page.waitFor(`!window.__beforeTakeIn && typeof currentData === 'object' && currentData.windows.length > 0`, 30000));
        const names = await windowNames(page);
        check('the new method and class are on the canvas',
            names.some(n => /liveProbe/.test(n)) && names.some(n => /LiveHelper/.test(n)) && names.some(n => /live\.md/.test(n)), names);
        check('the badge says 3 files, up to date',
            await page.waitFor(`/3 ファイル/.test(${LIVE_TEXT}) && /最新/.test(${LIVE_TEXT})`, 30000), await page.evaluate(LIVE_TEXT));
        await sleep(1500);   // the auto layout settles
        await shot(page, '3-live-taken-in.png');

        // A commit change set switches to live from its badge
        const commit = JSON.parse(cli(['changeset', fixture.commit, '--json']).trim().split('\n').pop());
        await page.send('Page.navigate', { url: commit.permalink });
        check('a commit change set offers ライブ追従を開始',
            await page.waitFor(`/ライブ追従を開始/.test(${LIVE_TEXT})`, 30000), await page.evaluate(LIVE_TEXT).catch(() => ''));
        await shot(page, '4-commit-offers-live.png');
        check('clicking it works', await clickLink(page, '● ライブ追従を開始'));
        check('the tab moves to a live canvas with the commit\'s change and everything since',
            await page.waitFor(`location.pathname !== ${JSON.stringify('/c/' + commit.canvasId)} && typeof currentData === 'object'
                && /● LIVE/.test(${LIVE_TEXT}) && currentData.windows.some(w => /changeSetProbe/.test(w.displayName))
                && currentData.windows.some(w => /liveProbe/.test(w.displayName))`, 300000),
            await page.evaluate('location.pathname + " " + ' + LIVE_TEXT).catch(() => ''));
        await sleep(1500);
        await shot(page, '5-switched-to-live.png');
    } catch (error) {
        check('no exception', false, String(error && error.stack || error));
    } finally {
        if (page) { page.close(); }
        if (browser) { browser.proc.kill('SIGKILL'); }
        if (fixture) {
            try { execFileSync('node', [CLI, 'stop'], { cwd: fixture.repo, encoding: 'utf8' }); } catch { /* not running */ }
            fs.rmSync(fixture.workDir, { recursive: true, force: true });
        }
    }
    console.log(`\nPASS ${pass}, FAIL ${fail}`);
    process.exit(fail ? 1 : 0);
})();
