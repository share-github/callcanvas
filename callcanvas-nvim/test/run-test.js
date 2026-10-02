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
const { createChangeSetFixture } = require('./changeset-fixture');

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

/** @returns {Promise<{stdout: string, stderr: string, code: number}>} */
function runCli(args, options = {}) {
    return new Promise((resolve) => {
        execFile(process.execPath, [CLI, ...args], {
            timeout: options.timeout || 60000,
            cwd: options.cwd,
            env: options.env ? Object.assign({}, process.env, options.env) : undefined
        }, (error, stdout, stderr) => {
            resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code: error && error.code ? error.code : 0 });
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
        if (status.stdout.includes('"running":false')) {
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

/**
 * `callcanvas build-index` with no host running: the CLI starts one itself. Pointed
 * at a project with no Java in it the command can only fail, which is what makes it
 * a cheap check that a failure really is reported as one (the extensions show an
 * error toast and return normally, so silence used to look like success).
 */
async function testBuildIndexCliFailure() {
    section('callcanvas build-index reports a failure');
    const jsOnly = path.join(REPO_ROOT, 'sample-project/sample-nextjs/package.json');
    if (!fs.existsSync(jsOnly)) {
        console.log('  SKIP: sample-nextjs not found');
        return;
    }
    const result = await runCli(['build-index', '--file', jsOnly]);
    check('the CLI exits non-zero', result.code === 1, `code=${result.code}`);
    check('the error is on stdout as JSON',
        /"ok":false/.test(result.stdout) && /"error":"[^"]+"/.test(result.stdout),
        result.stdout.trim().split('\n').pop());
}

/**
 * `callcanvas changeset <hash>` from a directory (Neovim's cwd, no buffer): the CLI
 * starts a long-lived host like `open` does, the viewer's `callcanvas.openChangeSet`
 * takes the hash as its argument (no prompt), and the canvas is reachable through
 * the usual multi-canvas routes (/c/<id>, /k/<key>/<id>, status). The canvas is named
 * after the commit, and the answer carries what Neovim shows (files / islands).
 */
async function testChangeSetCli() {
    section('callcanvas changeset <hash> | workbench (CLI, directory anchor)');
    let fixture;
    try {
        fixture = createChangeSetFixture();
    } catch (error) {
        console.log(`  SKIP: ${error.message}`);
        return;
    }
    const opts = { cwd: fixture.repo, env: fixture.env, timeout: 600000 };
    try {
        const result = await runCli(['changeset', fixture.commit, '--json'], opts);
        check('changeset exits 0', result.code === 0, `code=${result.code} ${result.stderr.trim()}`);
        let body = {};
        try { body = JSON.parse(result.stdout.trim().split('\n').pop()); } catch { /* checked below */ }
        check('the answer names the new canvas', typeof body.canvasId === 'string' && body.canvasId.length > 0,
            result.stdout.trim().split('\n').pop());
        check('permalink is /c/<canvasId>', String(body.permalink).includes(`/c/${body.canvasId}?t=`), body.permalink);
        check('short URL points at this canvas (/k/<key>/<canvasId>)',
            new RegExp(`/k/[^/]+/${body.canvasId}$`).test(String(body.shortUrl)), body.shortUrl);
        check('project root is the repository (anchor = cwd)', body.projectRoot === fixture.repo, body.projectRoot);

        const outDir = path.join(fixture.repo, 'build/call-hierarchy-output');
        const saved = fs.existsSync(outDir)
            ? fs.readdirSync(outDir).filter(n => /^callcanvas_changeset_.*\.json$/.test(n))
            : [];
        check('the canvas JSON is written to build/call-hierarchy-output', saved.length === 1, saved.join(','));
        const canvas = saved.length ? JSON.parse(fs.readFileSync(path.join(outDir, saved[0]), 'utf8')) : {};
        const meta = (canvas.metadata && canvas.metadata.changeSet) || {};
        check('the canvas is a change set for the commit',
            meta.kind === 'commit' && String(meta.commit).startsWith(fixture.commit), JSON.stringify({ kind: meta.kind, commit: meta.commit }));
        check('the changed method is on the canvas',
            (canvas.windows || []).some(w => /changeSetProbe/.test(w.displayName || '')));

        const islands = (canvas.groups || []).filter(g => g.kind === 'island').length;
        check('the canvas is named "変更集合 <hash> <subject>" (not after its first window)',
            body.title === `変更集合 ${fixture.commit} ${fixture.subject}`, body.title);
        check('the answer carries what Neovim shows: commit, subject, files, islands',
            body.changeSet && body.changeSet.kind === 'commit' && body.changeSet.commit === fixture.commit
            && body.changeSet.subject === fixture.subject
            && body.changeSet.fileCount === (meta.files || []).length && body.changeSet.islandCount === islands
            && islands > 0,
            JSON.stringify(body.changeSet));

        if (body.permalink) {
            const page = await get(body.permalink.replace(/\/c\/.*/, ''), body.permalink.replace(/^https?:\/\/[^/]+/, ''));
            check('/c/<canvasId> serves the change set canvas', page.status === 200 && page.body.includes('changeSetProbe'),
                `status=${page.status}`);
        }
        const status = await runCli(['status', '--json'], opts);
        let listed = [];
        try { listed = JSON.parse(status.stdout).canvases || []; } catch { /* checked below */ }
        const entry = listed.find(c => String(c.url).includes(`/c/${body.canvasId}`));
        check('status lists the canvas under the change set name',
            !!entry && entry.title === `変更集合 ${fixture.commit} ${fixture.subject}`, status.stdout.trim());

        const clean = await runCli(['changeset', 'workbench'], opts);
        check('an empty workbench exits non-zero', clean.code === 1, `code=${clean.code}`);
        check('... and says so like the diff display (ワークベンチの変更: 0 ファイル)',
            /ワークベンチの変更: 0 ファイル/.test(clean.stderr), clean.stderr.trim());

        const range = await runCli(['changeset', `${fixture.commit}~1..${fixture.commit}`], opts);
        check('a range is refused (one commit or the workbench)',
            range.code === 1 && /範囲は指定できません/.test(range.stderr), `code=${range.code} ${range.stderr.trim()}`);

        const bad = await runCli(['changeset', 'no-such-rev'], opts);
        check('an unknown revision exits non-zero with the reason', bad.code === 1 && /no-such-rev/.test(bad.stderr),
            `code=${bad.code} ${bad.stderr.trim()}`);
    } finally {
        await runCli(['stop'], opts);
        fs.rmSync(fixture.workDir, { recursive: true, force: true });
    }
}

/** Host-side QuickPick forwarded to Neovim: one line per item, `label — description`. */
function testQuickPickLines() {
    section('QuickPick forwarded to Neovim: label — description');
    const { quickPickLines } = require('../src/host');
    const lines = quickPickLines([
        { label: 'app', description: '/work/app' },
        { label: 'sample-app', description: '' },
        'plain'
    ]);
    check('an item with a description reads "label — description"', lines[0] === 'app — /work/app', lines[0]);
    check('an item without one is just the label', lines[1] === 'sample-app', lines[1]);
    check('a string item is kept', lines[2] === 'plain', lines[2]);
}

// --- unit-ish checks that need no host ------------------------------------
function testSavedCanvasData() {
    section('reload: the served initialData comes from the canvas JSON on disk');
    const { withSavedCanvasData } = require('../src/server');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'callcanvas-reload-'));
    const jsonPath = path.join(dir, 'canvas.json');
    const html = '<script>window.CALLCANVAS_CONFIG = {\n'
        + '            initialData: {"windows":[{"id":"window-1"}],"connections":[]},\n'
        + '            jsonFilePath: "x"\n        };</script>';
    fs.writeFileSync(jsonPath, JSON.stringify({ windows: [{ id: 'window-1', code: 'a </script> b' }, { id: 'window-field-1', windowType: 'field' }] }));
    const out = withSavedCanvasData(html, jsonPath);
    const data = extractInitialData(out);
    check('initialData replaced by the file (defaults filled in)',
        !!data && data.windows.length === 2 && Array.isArray(data.connections) && data.autoLayout === true);
    check('"<" is escaped so the JSON cannot close the script tag', !out.includes('</script> b') && data.windows[0].code === 'a </script> b');
    check('the rest of the HTML is kept', out.startsWith('<script>window.CALLCANVAS_CONFIG') && out.includes('jsonFilePath: "x"'));
    fs.writeFileSync(jsonPath, '{ not json');
    check('broken JSON -> HTML unchanged', withSavedCanvasData(html, jsonPath) === html);
    fs.writeFileSync(jsonPath, '');
    check('empty file -> HTML unchanged', withSavedCanvasData(html, jsonPath) === html);
    check('missing file / no path -> HTML unchanged',
        withSavedCanvasData(html, path.join(dir, 'nope.json')) === html && withSavedCanvasData(html, '') === html);
    fs.writeFileSync(jsonPath, '{"windows":[]}');
    check('HTML without initialData -> unchanged', withSavedCanvasData('<p>x</p>', jsonPath) === '<p>x</p>');
    fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * `callcanvas canvases` / `callcanvas comment`: an AI (the callcanvas-comment skill) comments on
 * a canvas by file + line, with no host running. Stored where the viewer stores its own comments.
 */
async function testCommentCli() {
    section('callcanvas canvases / comment (AI comments by file + line, no host)');
    const { withSavedCanvasData } = require('../src/server');
    const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'callcanvas-comment-'));
    const outDir = path.join(root, 'build', 'call-hierarchy-output');
    fs.mkdirSync(outDir, { recursive: true });
    const sample = path.join(REPO_ROOT, 'vscode-callcanvas-viewer/test-fixtures/changeset/sample-contract.json');
    const changeSet = path.join(outDir, 'callcanvas_changeset_e4f5a6b7.json');
    fs.copyFileSync(sample, changeSet);
    const jsCanvas = path.join(root, 'app_main_callcanvas.json');
    fs.writeFileSync(jsCanvas, JSON.stringify({ windows: [
        { id: 'window-1', displayName: 'main', filePath: 'src/app.js', startLine: 3, code: 'function main() {\n  run();\n}' },
    ], connections: [] }, null, 2));
    // the JS canvas is older: the change set comes first
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(jsCanvas, past, past);
    const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
    const win = (p, id) => read(p).windows.find(w => w.id === id);
    const cli = args => runCli([...args, '--root', root], { cwd: root });

    const listed = await cli(['canvases', '--json']);
    let list = null;
    try { list = JSON.parse(listed.stdout); } catch { /* checked below */ }
    check('canvases lists the change set (build/call-hierarchy-output) and the root *_callcanvas.json, newest first',
        list && list.canvases.length === 2 && list.canvases[0].path === changeSet && list.canvases[1].path === jsCanvas,
        listed.stdout + listed.stderr);
    const create = list && list.canvases[0].windows.find(w => w.id === 'w-order-create');
    check('each window: file, line range and the added / removed lines',
        !!create && create.filePath === 'src/main/java/com/example/order/OrderController.java'
        && create.startLine === 24 && create.endLine === 28
        && JSON.stringify(create.addedLines) === '[26]' && JSON.stringify(create.removedLines) === '[26]',
        JSON.stringify(create));
    const text = await cli(['canvases']);
    check('canvases (text) prints file:start-end per window',
        text.stdout.includes('w-order-create  src/main/java/com/example/order/OrderController.java:24-28'), text.stdout);

    const original = read(changeSet);
    const ctx = await cli(['comment', '--file', 'src/main/java/com/example/order/OrderController.java', '--line', '25', '--text', 'context line']);
    check('an unchanged line -> lineComments (default canvas = newest)',
        ctx.code === 0 && win(changeSet, 'w-order-create').lineComments['25'] === 'context line', ctx.stdout + ctx.stderr);
    const added = await cli(['comment', '--file', 'OrderController.java', '--line', '26', '--text', 'added line']);
    check('an added line (by its new number, file by its tail) -> diffState.diffComments["added:N"]',
        added.code === 0 && win(changeSet, 'w-order-create').diffState.diffComments['added:26'] === 'added line'
        && !('26' in win(changeSet, 'w-order-create').lineComments), added.stdout + added.stderr);
    const removed = await cli(['comment', '--file', 'OrderController.java', '--line', '26', '--diff', 'removed', '--text', 'removed line']);
    check('--diff removed (old line number) -> diffComments["removed:N"]',
        removed.code === 0 && win(changeSet, 'w-order-create').diffState.diffComments['removed:26'] === 'removed line',
        removed.stdout + removed.stderr);
    const after = read(changeSet);
    const strip = d => JSON.stringify(d, (k, v) => (k === 'lineComments' || k === 'diffComments') ? undefined : v);
    check('nothing but the comments changes in the JSON', strip(after) === strip(original));

    const outside = await cli(['comment', '--file', 'OrderController.java', '--line', '99', '--text', 'x']);
    check('a line not on the canvas fails (exit 1) and says which lines are',
        outside.code === 1 && outside.stdout.includes('FAILED') && outside.stdout.includes('w-order-create 24-28'),
        outside.stdout);
    const unknown = await cli(['comment', '--file', 'Nope.java', '--line', '1', '--text', 'x']);
    check('a file not on the canvas fails', unknown.code === 1 && /not on this canvas/.test(unknown.stdout), unknown.stdout);
    check('a failed comment leaves the JSON as it was', JSON.stringify(read(changeSet)) === JSON.stringify(after));

    const batchFile = path.join(root, 'batch.json');
    fs.writeFileSync(batchFile, JSON.stringify([
        { file: 'src/app.js', line: 4, text: 'calls run' },
        { file: 'src/app.js', line: 9, text: 'outside' },
    ]));
    const batch = await cli(['comment', '--batch', batchFile, '--canvas', 'app_main_callcanvas.json', '--json']);
    let batchResult = null;
    try { batchResult = JSON.parse(batch.stdout); } catch { /* checked below */ }
    check('--batch + --canvas <file name>: the valid ones are written, the others reported',
        batch.code === 1 && batchResult && batchResult.applied.length === 1 && batchResult.failed.length === 1
        && win(jsCanvas, 'window-1').lineComments['4'] === 'calls run', batch.stdout + batch.stderr);

    const replaced = await cli(['comment', '--file', 'OrderController.java', '--line', '25', '--text', 'new text', '--canvas', changeSet]);
    check('an existing comment is replaced and the output says so',
        replaced.stdout.includes('replaced') && win(changeSet, 'w-order-create').lineComments['25'] === 'new text', replaced.stdout);
    await cli(['comment', '--file', 'OrderController.java', '--line', '25', '--remove', '--canvas', changeSet]);
    await cli(['comment', '--file', 'OrderController.java', '--line', '26', '--remove', '--canvas', changeSet]);
    await cli(['comment', '--file', 'OrderController.java', '--line', '26', '--diff', 'removed', '--remove', '--canvas', changeSet]);
    const cleared = win(changeSet, 'w-order-create');
    check('--remove deletes them (empty maps are dropped)',
        !('lineComments' in cleared) && !('diffComments' in cleared.diffState), JSON.stringify(cleared));

    // deleted method / deleted file windows (change.source "base") show the OLD file as plain lines:
    // reachable only with --diff removed (old line number), stored in lineComments like the viewer does
    const deleted = path.join(outDir, 'callcanvas_changeset_deleted1.json');
    fs.writeFileSync(deleted, JSON.stringify({ windows: [
        { id: 'f-file', windowType: 'file', filePath: 'src/Svc.java', startLine: 15, code: 'a\nb\nc',
            change: { status: 'modified', source: 'worktree' },
            diffState: { hunks: [{ oldStart: 16, oldCount: 2, newStart: 15, newCount: 0,
                lines: [{ type: 'remove', content: 'old16' }, { type: 'remove', content: 'old17' }] }] } },
        { id: 'd-method', windowType: 'file', filePath: 'src/Svc.java', startLine: 16, code: 'old16\nold17',
            change: { status: 'modified', source: 'base', flags: ['deletedMethod'] } },
        { id: 'd-file', windowType: 'file', filePath: 'docs/gone.txt', startLine: 1, code: 'x\ny',
            change: { status: 'deleted', source: 'base', flags: ['deleted'] } },
    ], connections: [] }, null, 2));
    const dl = await cli(['canvases', '--canvas', deleted, '--json']);
    let dWins = null;
    try { dWins = JSON.parse(dl.stdout).canvases[0].windows; } catch { /* checked below */ }
    check('canvases marks deleted content windows (all lines removed, old numbers)',
        !!dWins && dWins.find(w => w.id === 'd-method').baseContent === true
        && JSON.stringify(dWins.find(w => w.id === 'd-method').removedLines) === '[16,17]'
        && dWins.find(w => w.id === 'd-file').baseContent === true, dl.stdout + dl.stderr);
    const rm17 = await cli(['comment', '--file', 'Svc.java', '--line', '17', '--diff', 'removed', '--text', 'gone', '--canvas', deleted]);
    check('--diff removed reaches the deleted method window (lineComments) and the file window (diffComments)',
        rm17.code === 0 && win(deleted, 'd-method').lineComments['17'] === 'gone'
        && win(deleted, 'f-file').diffState.diffComments['removed:17'] === 'gone', rm17.stdout + rm17.stderr);
    const plain17 = await cli(['comment', '--file', 'Svc.java', '--line', '17', '--text', 'new 17', '--canvas', deleted]);
    check('a plain (new-file) line number does not land on the deleted content',
        plain17.code === 0 && win(deleted, 'f-file').lineComments['17'] === 'new 17'
        && win(deleted, 'd-method').lineComments['17'] === 'gone', plain17.stdout + plain17.stderr);
    const gonePlain = await cli(['comment', '--file', 'docs/gone.txt', '--line', '1', '--text', 'x', '--canvas', deleted]);
    const goneRemoved = await cli(['comment', '--file', 'docs/gone.txt', '--line', '1', '--diff', 'removed', '--text', 'was here', '--canvas', deleted]);
    check('a deleted file: without --diff removed it fails and says to use it; with it -> lineComments',
        gonePlain.code === 1 && gonePlain.stdout.includes('--diff removed')
        && goneRemoved.code === 0 && win(deleted, 'd-file').lineComments['1'] === 'was here',
        gonePlain.stdout + goneRemoved.stdout);

    await cli(['comment', '--file', 'OrderController.java', '--line', '27', '--text', 'shown after reload', '--canvas', changeSet]);
    const html = '<script>window.CALLCANVAS_CONFIG = {\n'
        + '            initialData: {"windows":[],"connections":[]},\n'
        + '            jsonFilePath: "x"\n        };</script>';
    const served = extractInitialData(withSavedCanvasData(html, changeSet));
    check('a browser reload serves the comment (the host reads the JSON on disk)',
        !!served && served.windows.find(w => w.id === 'w-order-create').lineComments['27'] === 'shown after reload');
    fs.rmSync(root, { recursive: true, force: true });
}

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

/**
 * The project root handed to the extensions is also their workspace boundary: they
 * only walk up that far, so a submodule as root hides every other module and
 * cross-module calls resolve to nothing.
 */
function testMultiModuleRoot() {
    section('multi-module: the project root is the root of the build');
    const cases = [
        // Explicit aggregators.
        ['sample-project/sample-maven-multi-module/module-app', 'sample-project/sample-maven-multi-module'],
        ['sample-project/sample-multi-module-app/module-service', 'sample-project/sample-multi-module-app'],
        // No aggregator file: the modules name each other in their poms.
        ['sample-project/sample-cross-module-app/module-front', 'sample-project/sample-cross-module-app'],
        ['sample-project/sample-cross-module-app/module-core', 'sample-project/sample-cross-module-app'],
        // Unrelated projects that merely share a parent directory stay separate —
        // grouping them would analyse and index everything beside them.
        ['sample-project/spring-petclinic', 'sample-project/spring-petclinic'],
        ['sample-project/sample-app', 'sample-project/sample-app'],
        ['sample-project/large-ecommerce-app', 'sample-project/large-ecommerce-app'],
        // A package.json project has no modules to widen to.
        ['sample-project/sample-nextjs', 'sample-project/sample-nextjs'],
        // A project directly under the repository root keeps its own root.
        ['sample-app', 'sample-app']
    ];
    for (const [from, expected] of cases) {
        const start = path.join(REPO_ROOT, from);
        if (!fs.existsSync(start)) {
            console.log(`  SKIP ${from} (not in this checkout)`);
            continue;
        }
        const got = detectProjectRoot(start);
        check(`${from} -> ${expected}`, got === path.join(REPO_ROOT, expected), got);
    }
}

// --- the browser-side bridge, run on a minimal DOM stub --------------------
// A block comment that spans two lines: highlighting line by line would break it.
const FILE_TEXT = '/* a\nb */ int x;';
const HIGHLIGHTED = '<span class="hljs-comment">/* a\nb */</span> <span class="hljs-keyword">int</span> x;';

function loadBridge(settings, options = {}) {
    const handlers = [];
    let lastBadge = null;
    const appended = [];
    const calls = { jumpBack: 0, toasts: [], fetched: [], dispatched: [] };
    const element = () => {
        const node = {
            style: {},
            children: [],
            textContent: '',
            listeners: {},
            className: '',
            innerHTML: null,
            scrollIntoView() {},
            setAttribute(name, value) {
                // Mirror the browser enough that reading node.style.* back works.
                if (name === 'style') {
                    String(value).split(';').forEach(decl => {
                        const [prop, val] = decl.split(':');
                        if (prop && val) { node.style[prop.trim()] = val.trim(); }
                    });
                }
            },
            appendChild(child) {
                node.children.push(child);
                if (child && typeof child === 'object') { child.parentNode = node; }
                return child;
            },
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
        fetch: (u, init) => {
            calls.fetched.push(u);
            if (String(u).includes('/api/file')) {
                // Echo the requested path back, like the host does.
                const asked = decodeURIComponent((String(u).match(/[?&]p=([^&]*)/) || [])[1] || 'src/A.java');
                return Promise.resolve({
                    json: () => Promise.resolve({
                        ok: true,
                        path: '/abs/' + asked,
                        relPath: asked,
                        line: 2,
                        text: options.fileText !== undefined ? options.fileText : FILE_TEXT
                    })
                });
            }
            return Promise.resolve({ json: () => Promise.resolve({ canvases: [] }) });
        },
        EventSource: function () {
            this.close = () => {};
            this.readyState = 1;
        },
        sessionStorage: { getItem: () => null, setItem: () => {} },
        location: { reload: () => {} },
        innerWidth: 1400,
        KeyboardEvent: function (type, init) {
            Object.assign(this, { type: type }, init || {});
        },
        document: {
            readyState: 'complete',
            addEventListener: (type, fn, capture) => handlers.push({ type, fn, capture }),
            // Selection state the close key looks at.
            querySelector: (sel) => (options.selected && options.selected.includes(sel)
                ? { sel }
                : null),
            createElement: element,
            createTextNode: (text) => ({ text }),
            documentElement: {
                appendChild(node) { lastBadge = node; appended.push(node); return node; },
                dispatchEvent(event) { calls.dispatched.push(event); return true; }
            },
            body: {
                tagName: 'BODY',
                appendChild(node) { lastBadge = node; appended.push(node); return node; },
                dispatchEvent(event) { calls.dispatched.push(event); return true; }
            },
            getElementById: () => null
        }
    };
    sandbox.window = sandbox;
    sandbox.__CALLCANVAS_BRIDGE__ = {
        token: 't', canvasId: 'c1', follow: true, permalink: 'p', listUrl: 'l', settings
    };
    // Mirrors the viewer's custom highlight.js bundle: java/javascript/typescript/xml
    // plus plaintext, and a value whose spans straddle a newline.
    sandbox.hljs = {
        getLanguage: (lang) => ['java', 'javascript', 'typescript', 'xml', 'plaintext'].includes(lang),
        highlight: (text, options) => {
            calls.highlighted = { length: String(text).length, language: options && options.language };
            return { value: HIGHLIGHTED };
        }
    };
    sandbox.jumpBack = () => { calls.jumpBack++; };
    if (options.realHljs) {
        // Load the viewer's own highlight.js bundle instead of the stub.
        delete sandbox.hljs;
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(options.realHljs, 'utf8'), sandbox);
    }
    sandbox.showToast = (text) => { calls.toasts.push(text); };
    sandbox.addEventListener = () => {};

    if (!vm.isContext(sandbox)) {
        vm.createContext(sandbox);
    }
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
    const dblclickHandler = handlers.find(h => h.type === 'dblclick');
    const dblclick = (target) => {
        dblclickHandler.fn(Object.assign({ target }, { target }));
    };
    /** Every node with a non-null innerHTML, i.e. the highlighted code cells. */
    const highlightedCells = () => {
        const out = [];
        const walk = (node, depth = 0) => {
            if (!node || depth > 8) { return; }
            if (typeof node.innerHTML === 'string') { out.push(node); }
            (node.children || []).forEach(child => walk(child, depth + 1));
        };
        appended.forEach(node => walk(node));
        return out;
    };
    const panelBody = () => {
        for (const node of appended) {
            const found = (node.children || []).find(c => c.className === 'code-area');
            if (found) { return found; }
        }
        return null;
    };
    return {
        sandbox, calls, keydown, press, clickAll, dblclick,
        badge: () => lastBadge, highlightedCells, panelBody
    };
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

    section('browser bridge: file panel (default = the browser leaves Neovim alone)');
    const fileBridge = loadBridge({});
    const api = fileBridge.sandbox.acquireVsCodeApi();
    api.postMessage({ command: 'openFile', filePath: 'src/A.java', line: 12 });
    check('openFile asks the host for the file text',
        fileBridge.calls.fetched.some(u => String(u).includes('/api/file') && u.includes('src%2FA.java')),
        fileBridge.calls.fetched.join(' '));
    check('openFile does NOT touch Neovim by default',
        !fileBridge.calls.fetched.some(u => String(u).startsWith('/api/message')),
        fileBridge.calls.fetched.join(' '));

    const withJump = loadBridge({ nvimJump: true });
    withJump.sandbox.acquireVsCodeApi().postMessage({ command: 'openFile', filePath: 'src/A.java', line: 3 });
    check('nvimJump=true also forwards the jump to the host',
        withJump.calls.fetched.some(u => String(u).startsWith('/api/message'))
        && withJump.calls.fetched.some(u => String(u).includes('/api/file')),
        withJump.calls.fetched.join(' '));

    // The whole title bar must respond, not just the .file-path text.
    const barBridge = loadBridge({});
    const pathEl = {
        getAttribute: (name) => ({ 'data-filepath': 'src/B.java', 'data-line': '42' }[name])
    };
    const titleBar = { querySelector: () => pathEl };
    barBridge.dblclick({
        closest: (sel) => (sel === '.title-bar' ? titleBar : null),
        target: null
    });
    check('a double-click anywhere on the title bar opens the file',
        barBridge.calls.fetched.some(u => String(u).includes('/api/file') && u.includes('src%2FB.java')),
        barBridge.calls.fetched.join(' '));
    const onPathText = loadBridge({});
    onPathText.dblclick({
        closest: (sel) => (sel === '.file-path' ? pathEl : (sel === '.title-bar' ? titleBar : null))
    });
    check('viewer.js keeps owning the .file-path double-click (no double fire)',
        onPathText.calls.fetched.length === 0, onPathText.calls.fetched.join(' '));

    const custom = loadBridge({ jumpBackKey: 'shift+u', interceptBrowserBack: false });
    custom.press({ key: 'U', shiftKey: true });
    check('a configured key is honoured', custom.calls.jumpBack === 1);
    const notPrevented = custom.press({ key: 'ArrowLeft', altKey: true });
    check('interceptBrowserBack=false leaves the browser Back alone',
        custom.calls.jumpBack === 1 && notPrevented === false);
}

async function testFilePanelRendering() {
    section('browser bridge: file panel syntax highlighting');
    const bridge = loadBridge({});
    bridge.sandbox.acquireVsCodeApi().postMessage({ command: 'openFile', filePath: 'src/A.java', line: 2 });
    await new Promise(resolve => setTimeout(resolve, 10));

    check('the panel body reuses the viewer .code-area class (so viewer.css colours apply)',
        !!bridge.panelBody(), 'no .code-area element');
    check('the whole file is highlighted in one pass (not line by line)',
        bridge.calls.highlighted && bridge.calls.highlighted.length === FILE_TEXT.length,
        JSON.stringify(bridge.calls.highlighted));
    check('the language is resolved from the extension',
        bridge.calls.highlighted && bridge.calls.highlighted.language === 'java',
        String(bridge.calls.highlighted && bridge.calls.highlighted.language));

    const cells = bridge.highlightedCells().filter(c => c.innerHTML);
    check('every source line got highlighted HTML', cells.length === 2, String(cells.length));
    check('a span straddling a newline is closed on line 1',
        cells[0] && cells[0].innerHTML === '<span class="hljs-comment">/* a</span>',
        cells[0] && cells[0].innerHTML);
    check('…and reopened on line 2',
        cells[1] && cells[1].innerHTML.startsWith('<span class="hljs-comment">b */</span>')
        && cells[1].innerHTML.includes('hljs-keyword'),
        cells[1] && cells[1].innerHTML);

    // End-to-end with the viewer's real highlight.js bundle and a real source file.
    const hljsBundle = path.join(REPO_ROOT, 'vscode-callcanvas-viewer', 'media', 'highlight.min.js');
    const realSource = path.join(REPO_ROOT, 'sample-app/src/main/java/com/example/demo/service/TodoService.java');
    if (fs.existsSync(hljsBundle) && fs.existsSync(realSource)) {
        const sourceText = fs.readFileSync(realSource, 'utf8');
        const real = loadBridge({}, { realHljs: hljsBundle, fileText: sourceText });
        check('the real highlight.js bundle loads in the page context',
            typeof real.sandbox.hljs === 'object' && !!real.sandbox.hljs.highlight);
        real.sandbox.acquireVsCodeApi().postMessage({
            command: 'openFile', filePath: 'src/main/java/com/example/demo/service/TodoService.java', line: 34
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        const realCells = real.highlightedCells().filter(c => typeof c.innerHTML === 'string');
        const expectedLines = sourceText.split(/\r?\n/).length;
        check('a real Java file highlights every line',
            realCells.length === expectedLines, `${realCells.length} vs ${expectedLines}`);
        const joined = realCells.map(c => c.innerHTML).join('\n');
        check('real output carries hljs token classes',
            /hljs-keyword/.test(joined) && /hljs-comment/.test(joined),
            joined.slice(0, 120));
        // The sample file has no Javadoc block, so exercise a multi-line comment
        // explicitly against the real grammar.
        const javadoc = [
            '/**',
            ' * first line',
            ' * second line',
            ' */',
            'public class A {}'
        ].join('\n');
        const blockBridge = loadBridge({}, { realHljs: hljsBundle, fileText: javadoc });
        blockBridge.sandbox.acquireVsCodeApi().postMessage({
            command: 'openFile', filePath: 'A.java', line: 1
        });
        await new Promise(resolve => setTimeout(resolve, 20));
        const blockCells = blockBridge.highlightedCells().filter(c => typeof c.innerHTML === 'string');
        const commentLines = blockCells.filter(c => /hljs-comment/.test(c.innerHTML)).length;
        check('a multi-line comment keeps its colour on every one of its lines',
            commentLines === 4, `${commentLines}/4 lines`);
        check('code after the comment is highlighted as code, not comment',
            blockCells[4] && /hljs-keyword/.test(blockCells[4].innerHTML)
            && !/hljs-comment/.test(blockCells[4].innerHTML),
            blockCells[4] && blockCells[4].innerHTML);
    } else {
        check('real highlight.js fixture available', false, 'bundle or sample source missing');
    }

    // Unknown extension -> plaintext, never a thrown-away render.
    const plain = loadBridge({});
    plain.sandbox.acquireVsCodeApi().postMessage({ command: 'openFile', filePath: 'notes.rb', line: 1 });
    await new Promise(resolve => setTimeout(resolve, 10));
    check('an unregistered language falls back to plaintext',
        plain.calls.highlighted && plain.calls.highlighted.language === 'plaintext',
        String(plain.calls.highlighted && plain.calls.highlighted.language));
}

async function testCloseKey() {
    section('browser bridge: close key (ctrl+w is reserved by the browser)');

    // 1) the file panel is in front -> close that
    const withPanel = loadBridge({});
    withPanel.sandbox.acquireVsCodeApi().postMessage({ command: 'openFile', filePath: 'src/A.java', line: 1 });
    await new Promise(resolve => setTimeout(resolve, 10));
    const panel = withPanel.panelBody() && withPanel.panelBody().parentNode;
    check('the file panel is open before the key press',
        !!panel && panel.style.display === 'flex', panel && panel.style.display);

    const prevented = withPanel.press({ key: 'W', shiftKey: true });
    check('shift+w is captured (and kept from reaching the page)', prevented === true);
    check('shift+w closes the file panel',
        panel.style.display === 'none', panel.style.display);
    check('no Delete was sent while the panel was open',
        withPanel.calls.dispatched.length === 0,
        JSON.stringify(withPanel.calls.dispatched.map(e => e.key)));

    // Pressing it again with the panel closed and nothing selected falls through to
    // the canvas, which has nothing to close either -> a hint.
    withPanel.press({ key: 'W', shiftKey: true });
    check('a second shift+w falls through to the canvas',
        withPanel.calls.toasts.some(t => /閉じるもの/.test(t)),
        withPanel.calls.toasts.join(' | '));

    // 2) no panel, a window is selected -> viewer.js's own Delete path
    const selected = loadBridge({}, { selected: ['.code-window.selected'] });
    selected.press({ key: 'W', shiftKey: true });
    check('shift+w deletes the selected window through viewer.js',
        selected.calls.dispatched.some(e => e.key === 'Delete' && e.bubbles === true),
        JSON.stringify(selected.calls.dispatched.map(e => e.key)));

    // 3) nothing to close -> a hint, not a silent no-op
    const empty = loadBridge({});
    empty.press({ key: 'W', shiftKey: true });
    check('with nothing to close the user gets a hint',
        empty.calls.toasts.some(t => /閉じるもの/.test(t)), empty.calls.toasts.join(' | '));
    check('and nothing is deleted', empty.calls.dispatched.length === 0);

    // 4) configurable
    const custom = loadBridge({ closeKey: 'shift+q' }, { selected: ['.code-window.selected'] });
    custom.press({ key: 'Q', shiftKey: true });
    check('the close key is configurable',
        custom.calls.dispatched.some(e => e.key === 'Delete'));
    custom.press({ key: 'W', shiftKey: true });
    check('the default key is not also bound when overridden',
        custom.calls.dispatched.length === 1, String(custom.calls.dispatched.length));

    // 5) typing is never hijacked
    const typing = loadBridge({}, { selected: ['.code-window.selected'] });
    typing.press({ key: 'W', shiftKey: true, target: { tagName: 'INPUT' } });
    check('typing shift+w in a field does not close anything',
        typing.calls.dispatched.length === 0 && typing.calls.toasts.length === 0);
}

async function main() {
    testGlob();
    testConfig();
    testMultiModuleRoot();
    testBridgeKeys();
    testSavedCanvasData();
    await testFilePanelRendering();
    await testCloseKey();
    await testBuildIndexCliFailure();
    testQuickPickLines();
    await testChangeSetCli();
    await testCommentCli();

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

    // Before any browser attaches: a QuickPick ("which project?" when the call index
    // is built with no Java file open) must be put to Neovim. Answering it silently
    // means minutes spent indexing whichever project happened to be first.
    section('a QuickPick is put to Neovim');
    const realNvim = host.nvim;
    let asked = null;
    host.nvim = {
        available: true,
        select: async (prompt, items) => { asked = { prompt, items }; return 1; }
    };
    const chosen = await host.requestUi('pick', { items: ['app', 'sample-app'], placeHolder: 'which?' }, () => 0);
    check('the choice comes from Neovim, not from the fallback', chosen === 1, String(chosen));
    check('Neovim is given the items and the prompt',
        asked && asked.items.length === 2 && asked.prompt === 'which?', JSON.stringify(asked));
    host.nvim = { available: true, select: async () => -2 };
    check('cancelling in Neovim answers with nothing',
        (await host.requestUi('pick', { items: ['a'], placeHolder: 'p' }, () => 0)) === null);
    host.nvim = { available: true, select: async () => -1 };
    check('with nobody to ask (headless) the fallback decides',
        (await host.requestUi('pick', { items: ['a'], placeHolder: 'p' }, () => 0)) === 0);

    // The background index build (started by an analysis that finds no index) outlives
    // the analysis and reports only to an output channel, so Neovim has to be told
    // about it or the user sees one notification and then silence.
    section('long-running work is pushed to Neovim as progress');
    const pushed = [];
    host.nvim = { available: true, progress: async (text, active) => { pushed.push({ text, active }); } };
    host.lastProgressText = null;
    host.lastProgressAt = 0;

    await host.shim.vscode.window.withProgress({ title: 'Analyzing...' }, async (progress) => {
        progress.report({ message: 'Resolving method...' });
    });
    check('withProgress reaches Neovim, not only the browser',
        pushed.some(p => p.text === 'Analyzing...' && p.active === true)
            && pushed.some(p => p.text === 'Resolving method...'),
        JSON.stringify(pushed));
    check('the line goes away when the work ends',
        pushed[pushed.length - 1].active === false && pushed[pushed.length - 1].text === '',
        JSON.stringify(pushed[pushed.length - 1]));
    check('nothing is left running', host.workDepth === 0, String(host.workDepth));

    // The line is shown while something actually runs, and several things overlap: the
    // index build is started by an analysis and outlives it, so only the last one may
    // take the line down.
    pushed.length = 0;
    host.lastProgressText = null;
    host.beginWork('analyzing Foo.java:31');
    host.onOutput('Java Call Hierarchy', '[Auto-Index] Building index for: /tmp/x');
    await host.shim.vscode.window.withProgress({ title: 'Analyzing Foo#bar...' }, async () => {});
    check('a nested activity ending does not take the line down',
        !pushed.some(p => p.active === false), JSON.stringify(pushed));
    host.endWork();                                    // the analysis returns
    check('the line stays up for the index build that outlived it',
        !pushed.some(p => p.active === false) && host.workDepth === 1, String(host.workDepth));
    host.onOutput('Java Call Hierarchy', '[Auto-Index] Index built successfully in 900ms');
    check('the last activity clears it, with its outcome',
        pushed[pushed.length - 1].active === false
            && pushed[pushed.length - 1].text === 'call index built',
        JSON.stringify(pushed[pushed.length - 1]));
    check('no work left', host.workDepth === 0, String(host.workDepth));

    pushed.length = 0;
    host.lastProgressText = null;
    host.onOutput('Java Call Hierarchy', '[Auto-Index] Building index for: /tmp/x');
    host.onOutput('Java Call Hierarchy', '[Auto-Index] Command: java -jar ...');
    host.onOutput('Java Call Hierarchy', '[Auto-Index] [INFO] Found 22 Java files');
    host.onOutput('Java Call Hierarchy', 'Analyzing com.example.Foo#bar');
    check('the index build start is shown',
        pushed[0] && pushed[0].text === 'building the call index' && pushed[0].active === true,
        JSON.stringify(pushed[0]));
    check('the analyzer\'s own progress is shown',
        pushed.some(p => /Found 22 Java files/.test(p.text) && p.active === true),
        JSON.stringify(pushed));
    check('noisy and unrelated output lines are not',
        !pushed.some(p => /Command:|Analyzing com\.example/.test(p.text)), JSON.stringify(pushed));

    pushed.length = 0;
    host.onOutput('Java Call Hierarchy', '[Auto-Index] Error: spawn java ENOENT');
    host.onOutput('Java Call Hierarchy', '[Auto-Index] Failed after 12ms');
    check('a failed build says so and clears the line once',
        pushed.length === 1 && pushed[0].active === false && /failed/.test(pushed[0].text),
        JSON.stringify(pushed));
    check('no work left after a failure', host.workDepth === 0, String(host.workDepth));

    // Output lines that arrive with no build running (a stale log line) must not put a
    // line on screen that nothing will ever take down.
    pushed.length = 0;
    host.onOutput('Java Call Hierarchy', '[Auto-Index] [INFO] Found 22 Java files');
    check('progress without a running build is ignored', pushed.length === 0,
        JSON.stringify(pushed));

    // One `nvim --remote-expr` process per call, so repeats of the same line are dropped.
    pushed.length = 0;
    host.lastProgressText = null;
    host.nvimProgress('same text', true);
    host.nvimProgress('same text', true);
    check('the same line is not re-sent', pushed.length === 1, String(pushed.length));

    host.nvim = realNvim;

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
        check('the page tells the browser that Neovim driving is off by default',
            /"nvimJump":false/.test(page.body), (page.body.match(/"nvimJump":[a-z]+/) || [''])[0]);
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
        section('/api/file: the in-page file viewer');
        const fileApi = await get(base,
            `/api/file?t=${token}&p=${encodeURIComponent('src/main/java/com/example/demo/service/TodoService.java')}&line=34`);
        const filePayload = JSON.parse(fileApi.body);
        check('a relative path (what the viewer sends) resolves',
            fileApi.status === 200 && filePayload.ok === true, fileApi.body.slice(0, 120));
        check('the whole file comes back',
            filePayload.text.split('\n').length > 100,
            String(filePayload.text.split('\n').length));
        check('the requested line is reported', filePayload.line === 34);
        for (const bad of ['/etc/passwd', '../../../etc/passwd', 'src/../../../etc/passwd']) {
            const denied = await get(base, `/api/file?t=${token}&p=${encodeURIComponent(bad)}`);
            check(`a path outside the project is refused (${bad})`, denied.status === 404,
                String(denied.status));
        }
        check('/api/file needs the token',
            (await get(base, '/api/file?p=src/x.java')).status === 403);

        section('an editor open request goes to the browser, not to Neovim');
        // callcanvas.nvimJump is off by default, so "open this file" must come back as
        // a show-file event instead of poking an editor nobody is looking at.
        const shown = stream.wait(e => e.kind === 'show-file');
        await post(base, token, '/api/message', {
            canvasId: firstCanvasId,
            message: {
                command: 'openFile',
                filePath: 'src/main/java/com/example/demo/service/TodoService.java',
                line: 34
            }
        });
        const shownEvent = await shown;
        check('the host asks the browser to show the file',
            /TodoService\.java$/.test(shownEvent.path) && shownEvent.line === 34,
            JSON.stringify(shownEvent));
        check('no Neovim error toast is produced',
            !stream.events.some(e => e.kind === 'toast' && /ジャンプ/.test(e.text || '')),
            JSON.stringify(stream.events.filter(e => e.kind === 'toast').map(e => e.text)));

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

        // callcanvas-comment skill: the canvas the browser is showing is the default target
        const latestJson = summaries.find(c => c.latest).jsonPath;
        const forAi = await runCli(['canvases', '--file', TARGET_FILE, '--json']);
        let aiList = null;
        try { aiList = JSON.parse(forAi.stdout).canvases; } catch { /* checked below */ }
        check('canvases (CLI) lists the open canvases first, the one the browser follows as latest',
            !!aiList && aiList[0].path === latestJson && aiList[0].open === true && aiList[0].latest === true
            && aiList.filter(c => c.open).length === 2, forAi.stdout.slice(0, 300) + forAi.stderr);

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

        section('a browser reload shows the saved canvas (not the HTML from open time)');
        const reloadedFirst = extractInitialData((await get(base, `/c/${firstCanvasId}?t=${token}`)).body);
        check('a reload of the canvas serves the saved edit',
            !!reloadedFirst && reloadedFirst.windows[0].comment === 'callcanvas-nvim test marker');
        // A second tab of the same canvas: its reload shows what the first tab saved
        const otherTab = extractInitialData((await get(base, `/c/${firstCanvasId}?t=${token}`, { Cookie: '' })).body);
        check('another tab of that canvas sees the edit on its reload',
            !!otherTab && otherTab.windows[0].comment === 'callcanvas-nvim test marker');
        const untouchedSecond = extractInitialData((await get(base, `/c/${second.canvasId}?t=${token}`)).body);
        check('the other canvas is not affected',
            !!untouchedSecond && untouchedSecond.windows[0].comment !== 'callcanvas-nvim test marker');
        fs.writeFileSync(jsonPath, '{ broken', 'utf8');
        const brokenPage = await get(base, `/c/${firstCanvasId}?t=${token}`);
        const kept = extractInitialData(brokenPage.body);
        check('a broken canvas JSON falls back to the HTML the host holds',
            brokenPage.status === 200 && !!kept && kept.windows.length === extractInitialData(firstPage.body).windows.length
            && kept.windows[0].comment !== 'callcanvas-nvim test marker');
        fs.writeFileSync(jsonPath, before, 'utf8');

        // Anchored at the project directory, which is what `callcanvas build-index`
        // sends when Neovim has no file open (it falls back to its cwd). A directory
        // has no caret, so the project is resolved from the workspace instead.
        section('build the Java call index with no file open (directory anchor)');
        const indexPath = path.join(projectRoot, '.callcanvas-cache', 'call-index.json');
        const indexBefore = fs.existsSync(indexPath) ? fs.statSync(indexPath).mtimeMs : 0;
        const built = await post(base, token, '/api/open', {
            file: projectRoot,
            command: 'javaCallHierarchy.buildIndex'
        });
        check('buildIndex reported success', built.body && built.body.ok === true,
            JSON.stringify(built.body));
        check('the call index was (re)written',
            fs.existsSync(indexPath) && fs.statSync(indexPath).mtimeMs > indexBefore,
            `${indexPath} before=${indexBefore}`);

        // Analysis, unlike a command, does need a caret — but it must say so rather
        // than fail while building an editor out of the directory.
        const asAnalysis = await post(base, token, '/api/open', { file: projectRoot });
        check('analysing a directory is refused with a readable message',
            asAnalysis.body && asAnalysis.body.ok === false
                && /is a directory/.test(asAnalysis.body.error || ''),
            JSON.stringify(asAnalysis.body));

        // A command that only shows an error toast still returns normally, so the
        // caller would otherwise be told it succeeded.
        section('a command that fails is reported as a failure');
        const failed = await post(base, token, '/api/open', {
            file: TARGET_FILE,
            line: 1,
            command: 'javaCallHierarchy.openCallCanvasViewer'
        });
        check('an error toast turns into ok:false',
            failed.body && failed.body.ok === false && /cursor position/i.test(failed.body.error || ''),
            JSON.stringify(failed.body));

        // Building the index takes minutes with nobody watching a tab: the idle
        // shutdown must not fire in the middle of it.
        section('a running command holds off the idle shutdown');
        const savedTimeout = host.idleTimeoutMs;
        host.idleTimeoutMs = 60000;
        host.hadClient = true;
        host.runningCommands = 1;
        host.scheduleIdleShutdown();
        check('no idle timer while a command runs', host.idleTimer === null);
        host.runningCommands = 0;
        host.scheduleIdleShutdown();
        check('the idle timer is armed once it finishes', host.idleTimer !== null);
        clearTimeout(host.idleTimer);
        host.idleTimer = null;
        host.idleTimeoutMs = savedTimeout;
        host.hadClient = false;
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
