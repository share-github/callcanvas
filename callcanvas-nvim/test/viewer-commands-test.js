#!/usr/bin/env node
'use strict';
/**
 * Every command the viewer can send to the host, driven the way the browser drives
 * it (POST /api/message + SSE + /api/ui-reply), with assertions.
 *
 * run-test.js covers the plumbing and the fast paths; this suite covers the
 * analysis and editor-facing features that actually shell out to the analyzer, git
 * and the file system, so it is slower (a few minutes) and lives on its own.
 *
 *   node test/viewer-commands-test.js
 *
 * Requires java and the compiled extensions.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const { CallCanvasHost, detectProjectRoot } = require('../src/host');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const JAVA_FILE = path.join(REPO_ROOT, 'sample-app/src/main/java/com/example/demo/service/TodoService.java');
const JS_FILE = path.join(REPO_ROOT, 'vscode-javascript-call-hierarchy/test-fixtures/vanilla-js/app.js');
const TS_FILE = path.join(REPO_ROOT, 'vscode-typescript-call-hierarchy/test-fixtures/golden/ts-nested-function/nested.ts');
const JACOCO = path.join(REPO_ROOT, 'sample-project/sample-maven-multi-module/module-app/target/site/jacoco/jacoco.xml');

let passed = 0;
let failed = 0;
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

function post(base, token, pathname, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request(`${base}${pathname}?t=${token}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve(data ? JSON.parse(data) : null));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

function get(base, pathname) {
    return new Promise((resolve, reject) => {
        http.get(`${base}${pathname}`, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

/** Collects SSE events, like the browser bridge does. */
class EventStream {
    constructor(base, token, canvasId) {
        this.events = [];
        this.request = http.get(`${base}/api/events?t=${token}&c=${canvasId}&follow=1`, (res) => {
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
                    for (const item of payload.kind === 'batch' ? (payload.events || []) : [payload]) {
                        this.events.push(item);
                    }
                }
            });
        });
    }

    get mark() {
        return this.events.length;
    }

    since(mark) {
        return this.events.slice(mark);
    }

    /** Wait for an event matching `match` among those after `mark`. */
    async expect(mark, match, timeoutMs = 90000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const found = this.since(mark).find(match);
            if (found) {
                return found;
            }
            await wait(200);
        }
        return null;
    }

    posts(mark) {
        return this.since(mark).filter(e => e.kind === 'post').map(e => e.message.command);
    }

    close() {
        this.request.destroy();
    }
}

async function answerUi(base, token, stream, mark, value, timeoutMs = 20000) {
    const ui = await stream.expect(mark, e => e.kind === 'ui', timeoutMs);
    if (!ui) {
        return null;
    }
    await post(base, token, '/api/ui-reply', { id: ui.id, value });
    return ui;
}

/** Start a host for one project and open a canvas at `line`. */
async function openCanvas(file, line) {
    const projectRoot = detectProjectRoot(file);
    const host = new CallCanvasHost({
        projectRoot, nvimAddress: null, bindHost: '127.0.0.1', port: 0,
        idleTimeoutMs: 0, settings: {}, verbose: !!process.env.CALLCANVAS_TEST_VERBOSE
    });
    await host.start();
    const base = `http://127.0.0.1:${host.server.port}`;
    const token = host.server.token;
    const opened = await host.open({ file, line });
    if (!opened.ok) {
        throw new Error(`open(${path.basename(file)}) failed: ${opened.error}`);
    }
    const page = await get(base, `/?t=${token}`);
    const data = JSON.parse(page.match(/initialData: (\{[\s\S]*?\}),\n\s*jsonFilePath/)[1]);
    const jsonPath = page.match(/jsonFilePath: "([^"]*)"/)[1];
    const stream = new EventStream(base, token, opened.canvasId);
    await wait(400);
    return { host, base, token, opened, data, jsonPath, stream };
}

const codeText = (w) => (Array.isArray(w.code) ? w.code.map(l => l.content).join('\n') : String(w.code || ''));
const codeStart = (w) => ((Array.isArray(w.code) && w.code[0] && w.code[0].line) || w.startLine || 1);
const windowData = (w) => ({
    id: w.id, displayName: w.displayName, filePath: w.filePath,
    code: codeText(w), startLine: codeStart(w)
});

async function testJavaCommands() {
    section('Java canvas: every viewer command');
    const ctx = await openCanvas(JAVA_FILE, 34);
    const { host, base, token, data, jsonPath, stream } = ctx;
    const root = data.windows[0];

    try {
        let mark = stream.mark;
        await post(base, token, '/api/message', { message: { command: 'openJsonFile' } });
        const shown = await stream.expect(mark, e => e.kind === 'show-file', 10000);
        check('openJsonFile shows the canvas JSON in the browser',
            !!shown && shown.path.endsWith('.json'), shown && shown.path);

        mark = stream.mark;
        await post(base, token, '/api/message', {
            message: { command: 'analyzeIncomingCalls', windowData: windowData(root) }
        });
        const incoming = await stream.expect(mark, e => e.kind === 'post' && e.message.command === 'mergeCallCanvasData');
        check('analyzeIncomingCalls merges callers',
            !!incoming && incoming.message.data.windows.length > 0,
            incoming ? String(incoming.message.data.windows.length) : 'no merge');

        mark = stream.mark;
        await post(base, token, '/api/message', {
            message: { command: 'analyzeToRoot', windowData: windowData(root) }
        });
        const toRoot = await stream.expect(mark, e => e.kind === 'post' && e.message.command === 'mergeCallCanvasData');
        check('analyzeToRoot merges the caller chain',
            !!toRoot && toRoot.message.data.windows.length > 0,
            toRoot ? String(toRoot.message.data.windows.length) : 'no merge');

        mark = stream.mark;
        const backup = `${jsonPath}.bak`;
        try {
            fs.unlinkSync(backup);
        } catch { /* absent */ }
        await post(base, token, '/api/message', { message: { command: 'reanalyzeRoot' } });
        const reloaded = await stream.expect(mark, e => e.kind === 'post' && e.message.command === 'reloadData');
        check('reanalyzeRoot reloads the canvas',
            !!reloaded && reloaded.message.data.windows.length > 0,
            reloaded ? String(reloaded.message.data.windows.length) : 'no reload');
        check('reanalyzeRoot leaves a .bak behind', fs.existsSync(backup), backup);

        mark = stream.mark;
        await post(base, token, '/api/message', { message: { command: 'getWorkbenchChanges' } });
        const workbench = await stream.expect(mark, e => e.kind === 'post' && e.message.command === 'commitDiffDetails', 20000);
        check('getWorkbenchChanges answers with a diff payload',
            !!workbench && Array.isArray(workbench.message.diffs),
            workbench ? `${workbench.message.diffs.length} file(s)` : 'no diffs');

        mark = stream.mark;
        const head = execSync(`git -C ${REPO_ROOT} rev-parse --short HEAD`).toString().trim();
        await post(base, token, '/api/message', { message: { command: 'showCommitInputDialog' } });
        const asked = await answerUi(base, token, stream, mark, head);
        check('showCommitInputDialog asks the browser for a hash', !!asked && asked.type === 'input');
        const commitDiff = await stream.expect(mark, e => e.kind === 'post' && e.message.command === 'commitDiffDetails', 30000);
        check('a commit hash produces its diff',
            !!commitDiff && commitDiff.message.diffs.length > 0,
            commitDiff ? `${commitDiff.message.diffs.length} file(s)` : 'no diffs');

        if (fs.existsSync(JACOCO)) {
            mark = stream.mark;
            await post(base, token, '/api/message', { message: { command: 'loadCoverageReport' } });
            await answerUi(base, token, stream, mark, JACOCO);
            const coverage = await stream.expect(mark, e => e.kind === 'post' && e.message.command === 'applyCoverage', 30000);
            check('loadCoverageReport parses a real JaCoCo report',
                !!coverage && Object.keys(coverage.message.coverage).length > 0,
                coverage ? `${Object.keys(coverage.message.coverage).length} file(s)` : 'no coverage');
        } else {
            check('a JaCoCo fixture is available', false, JACOCO);
        }

        mark = stream.mark;
        await post(base, token, '/api/message', { message: { command: 'loadCoverageReport' } });
        await answerUi(base, token, stream, mark, path.join(os.tmpdir(), 'callcanvas-missing-coverage.xml'));
        const covError = await stream.expect(mark, e => e.kind === 'toast' && e.level === 'error', 20000);
        check('a missing coverage file is reported, not swallowed',
            !!covError && /カバレッジ/.test(covError.text), covError && covError.text);

        mark = stream.mark;
        await post(base, token, '/api/message', { message: { command: 'clearCoverage' } });
        check('clearCoverage reaches the canvas',
            !!(await stream.expect(mark, e => e.kind === 'post' && e.message.command === 'clearCoverage', 10000)));

        mark = stream.mark;
        const exportPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-export-')), 'canvas.html');
        await post(base, token, '/api/message', {
            message: { command: 'exportHtml', data: JSON.parse(fs.readFileSync(jsonPath, 'utf8')) }
        });
        await answerUi(base, token, stream, mark, exportPath);
        await stream.expect(mark, e => e.kind === 'toast', 20000);
        const exported = fs.existsSync(exportPath) ? fs.readFileSync(exportPath, 'utf8') : '';
        check('exportHtml writes a file', exported.length > 0, exportPath);
        check('the export is self-contained (inlined viewer, export mode)',
            /IS_EXPORT_MODE: true/.test(exported) && !/\/asset\?t=/.test(exported),
            `${Math.round(exported.length / 1024)} KB`);
        check('the export carries the canvas data', /initialData:/.test(exported));
        fs.rmSync(path.dirname(exportPath), { recursive: true, force: true });
    } finally {
        stream.close();
        await host.server.close();
        host.clearSession();
    }
}

async function testNextLevel(label, file, line) {
    section(`${label}: analyzeNextLevel from the browser`);
    const ctx = await openCanvas(file, line);
    const { host, base, token, data, stream } = ctx;
    try {
        const target = data.windows.find(w => w.id !== data.windows[0].id) || data.windows[0];
        const mark = stream.mark;
        await post(base, token, '/api/message', {
            message: { command: 'analyzeNextLevel', windowData: windowData(target) }
        });
        const merged = await stream.expect(mark, e => e.kind === 'post' && e.message.command === 'mergeCallCanvasData', 60000);
        check(`${label} analyzeNextLevel merges more windows`,
            !!merged && merged.message.data.windows.length > 0,
            merged ? `${merged.message.data.windows.length} window(s) for ${target.displayName}` : 'no merge');
    } finally {
        stream.close();
        await host.server.close();
        host.clearSession();
    }
}

async function main() {
    if (!fs.existsSync(JAVA_FILE)) {
        console.log(`SKIP: ${JAVA_FILE} not found`);
        return;
    }
    await testJavaCommands();
    if (fs.existsSync(JS_FILE)) {
        await testNextLevel('JavaScript', JS_FILE, 1);
    }
    if (fs.existsSync(TS_FILE)) {
        await testNextLevel('TypeScript', TS_FILE, 4);
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
