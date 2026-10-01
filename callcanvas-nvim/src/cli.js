#!/usr/bin/env node
'use strict';
/**
 * callcanvas — drive CallCanvas from Neovim (or any editor / shell).
 *
 *   callcanvas open --file <path> [--line N] [--nvim <servername>]
 *   callcanvas serve [--file <path> --line N] [--host H] [--port P]
 *   callcanvas command <commandId> [--arg <json>]...
 *   callcanvas build-index [--file <path>]
 *   callcanvas changeset [<hash>|workbench] [--file <path>]
 *   callcanvas status | stop
 *
 * `open` is the command Neovim calls: it reuses a running session for the same
 * project when there is one, otherwise it starts a detached `serve` process.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { CallCanvasHost, detectProjectRoot, sessionFile, sessionDir } = require('./host');

function parseArgs(argv) {
    const options = { _: [], set: {}, arg: [] };
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--')) {
            options._.push(token);
            continue;
        }
        const key = token.slice(2);
        const next = () => argv[++i];
        switch (key) {
            case 'file': options.file = next(); break;
            case 'line': options.line = parseInt(next(), 10); break;
            case 'nvim': options.nvim = next(); break;
            case 'nvim-pid': options.nvimPid = Number(next()); break;
            case 'root': options.root = next(); break;
            case 'host': options.host = next(); break;
            case 'port': options.port = parseInt(next(), 10); break;
            case 'idle-timeout': options.idleTimeout = parseInt(next(), 10); break;
            case 'timeout': options.timeout = parseInt(next(), 10); break;
            case 'browser': options.browser = true; break;
            case 'no-browser': options.browser = false; break;
            case 'verbose': options.verbose = true; break;
            case 'json': options.json = true; break;
            case 'no-token': options.auth = false; break;
            case 'arg': options.arg.push(next()); break;
            case 'set': {
                const pair = next() || '';
                const eq = pair.indexOf('=');
                if (eq > 0) {
                    const name = pair.slice(0, eq);
                    const raw = pair.slice(eq + 1);
                    let value = raw;
                    if (raw === 'true') { value = true; }
                    else if (raw === 'false') { value = false; }
                    else if (raw !== '' && !isNaN(Number(raw))) { value = Number(raw); }
                    options.set[name] = value;
                }
                break;
            }
            case 'help': options.help = true; break;
            default:
                throw new Error(`unknown option --${key}`);
        }
    }
    return options;
}

const USAGE = `callcanvas — CallCanvas viewer host for Neovim

Usage:
  callcanvas open --file <path> [--line N] [--nvim <servername>] [--nvim-pid <pid>] [options]
  callcanvas serve [--file <path>] [--line N] [options]
  callcanvas command <commandId> [--arg <json>] [--file <path> --line N]
  callcanvas build-index [--file <path>] [--root <dir>]
  callcanvas changeset [<hash>|workbench] [--file <path>] [--nvim <servername>] [--json] [options]
                       <hash>: that commit's changes (against its first parent);
                       workbench: the uncommitted changes (git diff HEAD);
                       omitted = ask (in Neovim when --nvim is given)
  callcanvas status [--root <dir>] [--json]
  callcanvas stop   [--root <dir>]

Options:
  --root <dir>         project root (default: git root / build file above --file)
  --host <addr>        bind address (default 127.0.0.1; use 0.0.0.0 for containers)
  --port <n>           port (default: an unused one)
  --idle-timeout <s>   exit this long after the last browser closes (default 300, 0 = never)
  --timeout <s>        how long to wait for a command / index build (default 1800)
  --set key=value      configuration override, e.g. --set callcanvas.windowWidth=800
  --browser            open the URL with the system browser
  --no-token           disable the token check (loopback only; convenience over safety)
  --verbose            log host activity to stderr
`;

function readSession(projectRoot) {
    try {
        return JSON.parse(fs.readFileSync(sessionFile(projectRoot), 'utf8'));
    } catch {
        return null;
    }
}

function request(session, pathname, body, timeoutMs = 120000) {
    return new Promise((resolve) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request({
            host: session.host === '0.0.0.0' ? '127.0.0.1' : session.host,
            port: session.port,
            path: `${pathname}${pathname.includes('?') ? '&' : '?'}t=${session.token}`,
            method: payload ? 'POST' : 'GET',
            headers: payload
                ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                : {},
            timeout: timeoutMs
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve({ ok: true, status: res.statusCode, body: data ? JSON.parse(data) : null });
                } catch {
                    resolve({ ok: true, status: res.statusCode, body: null });
                }
            });
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', (error) => resolve({ ok: false, error: error.message }));
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

async function isAlive(session) {
    if (!session) {
        return false;
    }
    try {
        process.kill(session.pid, 0);
    } catch {
        return false;
    }
    const result = await request(session, '/api/ping');
    return result.ok && result.body && result.body.ok === true;
}

function openInBrowser(url) {
    const opener = process.env.BROWSER
        || (process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'start' : 'xdg-open'));
    try {
        spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
    } catch { /* the URL is printed anyway */ }
}

/** The tail of the host log — the reason a start failed is almost always there. */
function lastLogLines(logPath, count = 3) {
    try {
        const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n');
        return lines.slice(-count).join(' | ') + ` (full log: ${logPath})`;
    } catch {
        return `see ${logPath}`;
    }
}

/** Start a detached `serve` process and wait until it answers /api/ping. */
async function spawnServer(projectRoot, options) {
    fs.mkdirSync(sessionDir(), { recursive: true });
    const logPath = sessionFile(projectRoot).replace(/\.json$/, '.log');
    const out = fs.openSync(logPath, 'a');

    const args = [__filename, 'serve', '--root', projectRoot, '--verbose'];
    if (options.auth === false) { args.push('--no-token'); }
    if (options.host) { args.push('--host', options.host); }
    if (options.port) { args.push('--port', String(options.port)); }
    if (options.idleTimeout !== undefined) { args.push('--idle-timeout', String(options.idleTimeout)); }
    for (const [key, value] of Object.entries(options.set || {})) {
        args.push('--set', `${key}=${value}`);
    }

    const child = spawn(process.execPath, args, {
        detached: true,
        stdio: ['ignore', out, out],
        cwd: projectRoot
    });
    child.unref();

    let exited = null;
    child.on('exit', (code) => { exited = code; });

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const session = readSession(projectRoot);
        if (session && session.pid !== undefined && await isAlive(session)) {
            return session;
        }
        if (exited !== null) {
            throw new Error(`host exited (code ${exited}): ${lastLogLines(logPath)}`);
        }
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`host did not start within 30s: ${lastLogLines(logPath)}`);
}

async function cmdOpen(options) {
    if (!options.file) {
        throw new Error('--file is required');
    }
    const file = path.resolve(options.file);
    if (!fs.existsSync(file)) {
        throw new Error(`file not found: ${file}`);
    }
    const projectRoot = options.root ? path.resolve(options.root) : detectProjectRoot(file);

    let session = readSession(projectRoot);
    if (!(await isAlive(session))) {
        session = await spawnServer(projectRoot, options);
    }

    const result = await request(session, '/api/open', {
        file,
        line: options.line || 1,
        nvim: options.nvim || process.env.NVIM || null,
        nvimPid: options.nvimPid || null
    });
    if (!result.ok) {
        throw new Error(`host request failed: ${result.error}`);
    }
    if (!result.body || result.body.ok !== true) {
        throw new Error((result.body && result.body.error) || 'open failed');
    }

    printOpened(session, result.body, projectRoot, options);
}

/** What `open` and `changeset` print: the host's answer (`--json`) or the canvas's short URL. */
function printOpened(session, body, projectRoot, options) {
    if (options.browser) {
        openInBrowser(session.url);
    }
    if (options.json) {
        // Pass the host's answer through as-is (shortUrl, permalink, canvas info …)
        // so the editor side can present whichever URL is most usable.
        process.stdout.write(JSON.stringify(Object.assign({
            url: session.url,
            bookmarkUrl: session.bookmarkUrl,
            clients: 0
        }, body, { projectRoot })) + '\n');
    } else {
        process.stdout.write((body.shortUrl || body.url || session.url) + '\n');
    }
}

async function cmdServe(options) {
    const anchor = options.file ? path.resolve(options.file) : process.cwd();
    const projectRoot = options.root ? path.resolve(options.root) : detectProjectRoot(anchor);

    const host = new CallCanvasHost({
        projectRoot,
        nvimAddress: options.nvim || process.env.NVIM || null,
        bindHost: options.host || '127.0.0.1',
        port: options.port || 0,
        idleTimeoutMs: options.idleTimeout === undefined ? undefined : options.idleTimeout * 1000,
        settings: options.set,
        auth: options.auth,
        verbose: options.verbose !== false
    });

    await host.start();
    process.stdout.write(host.url + '\n');

    const bye = () => { host.shutdown(); };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
    process.on('SIGHUP', () => {});

    if (options.file) {
        const result = await host.open({ file: path.resolve(options.file), line: options.line || 1 });
        if (!result.ok) {
            process.stderr.write(`open failed: ${result.error}\n`);
        }
        if (options.browser) {
            openInBrowser(host.url);
        }
    }
}

/**
 * `javaCallHierarchy.buildIndex` — the command behind `build-index`. The index is
 * what makes incoming-call analysis fast, and the Java extension builds it in the
 * background on demand; this is the explicit "build it now" route.
 */
const BUILD_INDEX_COMMAND = 'javaCallHierarchy.buildIndex';

/** Commands may run for minutes (a full index build), so they get their own budget. */
function commandTimeoutMs(options) {
    return (options.timeout ? options.timeout : 1800) * 1000;
}

async function cmdCommand(options, commandId = options._[1]) {
    if (!commandId) {
        throw new Error('a command id is required');
    }
    const anchor = options.file ? path.resolve(options.file) : process.cwd();
    const projectRoot = options.root ? path.resolve(options.root) : detectProjectRoot(anchor);

    const session = readSession(projectRoot);
    if (await isAlive(session)) {
        const result = await request(session, '/api/open', {
            file: anchor,
            line: options.line || 1,
            nvim: options.nvim || process.env.NVIM || null,
            command: commandId,
            args: options.arg.map(a => JSON.parse(a))
        }, commandTimeoutMs(options));
        if (!result.ok) {
            throw new Error(result.error || 'the running host did not answer');
        }
        process.stdout.write(JSON.stringify(result.body) + '\n');
        if (result.body && result.body.ok === false) {
            process.exitCode = 1;
        }
        return;
    }

    const host = new CallCanvasHost({
        projectRoot,
        nvimAddress: options.nvim || process.env.NVIM || null,
        bindHost: options.host || '127.0.0.1',
        port: options.port || 0,
        idleTimeoutMs: 0,
        settings: options.set,
        verbose: !!options.verbose
    });
    await host.start();
    const value = await host.runCommand(commandId, options.arg.map(a => JSON.parse(a)), {
        file: options.file,
        line: options.line
    });
    // Same rule as the live-session branch: a command that only showed an error
    // toast still "returns" normally, so the toast decides the exit status.
    const failure = host.lastError;
    if (failure) {
        process.stdout.write(JSON.stringify({ ok: false, error: failure }) + '\n');
    } else {
        process.stdout.write(JSON.stringify(value === undefined ? { ok: true } : value) + '\n');
    }
    // shutdown() ends the process, so the status has to be passed in — setting
    // process.exitCode here would be overwritten by its process.exit().
    await host.shutdown(failure ? 1 : 0);
}

/**
 * `callcanvas.openChangeSet` — the viewer command behind `changeset`. It takes a
 * commit hash or `workbench` as its argument; without one it asks (commit or
 * workbench, then the hash), which the host forwards to Neovim.
 */
const CHANGE_SET_COMMAND = 'callcanvas.openChangeSet';

/**
 * `callcanvas changeset [<hash>|workbench]` — one canvas for the changes of a commit
 * (or of the workbench, i.e. the uncommitted changes).
 * Unlike `command`, the canvas must stay viewable afterwards, so this goes through
 * a long-lived host (started like `open` when none is running), never a throwaway one.
 * The anchor may be a directory (cwd when Neovim has no buffer): the repository is
 * then found from the project root.
 */
async function cmdChangeSet(options) {
    const target = options._[1];
    const anchor = options.file ? path.resolve(options.file) : process.cwd();
    if (!fs.existsSync(anchor)) {
        throw new Error(`file not found: ${anchor}`);
    }
    const projectRoot = options.root ? path.resolve(options.root) : detectProjectRoot(anchor);

    let session = readSession(projectRoot);
    if (!(await isAlive(session))) {
        session = await spawnServer(projectRoot, options);
    }
    const result = await request(session, '/api/open', {
        file: anchor,
        line: options.line || 1,
        nvim: options.nvim || process.env.NVIM || null,
        nvimPid: options.nvimPid || null,
        command: CHANGE_SET_COMMAND,
        args: target ? [target] : []
    }, commandTimeoutMs(options));
    if (!result.ok) {
        throw new Error(`host request failed: ${result.error}`);
    }
    const body = result.body;
    if (!body || body.ok !== true) {
        throw new Error((body && body.error) || 'change set failed');
    }
    if (!body.canvasId) {
        // No changes ("…: 0 ファイル") or a cancelled prompt: nothing to open.
        throw new Error(body.message || 'no change set canvas was produced (cancelled?)');
    }
    printOpened(session, body, projectRoot, options);
}

/** `callcanvas build-index` — build the Java call index for this project. */
async function cmdBuildIndex(options) {
    return cmdCommand(options, BUILD_INDEX_COMMAND);
}

async function cmdStatus(options) {
    const projectRoot = options.root
        ? path.resolve(options.root)
        : detectProjectRoot(options.file ? path.resolve(options.file) : process.cwd());
    const session = readSession(projectRoot);
    const alive = await isAlive(session);
    let canvases = [];
    if (alive) {
        const result = await request(session, '/api/canvases');
        canvases = (result.body && result.body.canvases) || [];
    }
    if (options.json) {
        process.stdout.write(JSON.stringify({
            projectRoot,
            running: alive,
            session: alive ? session : null,
            canvases
        }) + '\n');
        return;
    }
    if (!alive) {
        process.stdout.write(`not running (${projectRoot})\n`);
        return;
    }
    process.stdout.write(`running  pid=${session.pid}\n`);
    process.stdout.write(`  newest   ${session.url}\n`);
    if (session.bookmarkUrl && session.bookmarkUrl !== session.url) {
        process.stdout.write(`  bookmark ${session.bookmarkUrl}   (works after the first visit)\n`);
    }
    process.stdout.write(`  canvases ${canvases.length}\n`);
    for (const canvas of canvases) {
        process.stdout.write(
            `    ${canvas.latest ? '*' : ' '} ${canvas.title}\n`
            + `        ${canvas.url}\n`
        );
    }
}

async function cmdStop(options) {
    const projectRoot = options.root
        ? path.resolve(options.root)
        : detectProjectRoot(options.file ? path.resolve(options.file) : process.cwd());
    const session = readSession(projectRoot);
    if (!(await isAlive(session))) {
        process.stdout.write('not running\n');
        return;
    }
    await request(session, '/api/shutdown', {});
    process.stdout.write('stopped\n');
}

async function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error.message}\n\n${USAGE}`);
        process.exit(2);
    }
    const command = options._[0];
    if (options.help || !command) {
        process.stdout.write(USAGE);
        return;
    }
    switch (command) {
        case 'open': await cmdOpen(options); return;
        case 'serve': await cmdServe(options); return;
        case 'command': await cmdCommand(options); return;
        case 'build-index': await cmdBuildIndex(options); return;
        case 'changeset': await cmdChangeSet(options); return;
        case 'status': await cmdStatus(options); return;
        case 'stop': await cmdStop(options); return;
        default:
            process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
            process.exit(2);
    }
}

main().catch((error) => {
    process.stderr.write(`callcanvas: ${error && error.message ? error.message : error}\n`);
    process.exit(1);
});
