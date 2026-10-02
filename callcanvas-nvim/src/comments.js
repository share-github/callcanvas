'use strict';
/**
 * Line comments written into a canvas JSON from outside the viewer (`callcanvas canvases` /
 * `callcanvas comment`): lets an AI that knows nothing about CallCanvas annotate a canvas by
 * "file + line", the way a human does with the viewer's comment insert.
 *
 * The JSON is written directly — no host, no viewer involved. A browser tab shows the comments
 * after a reload (the host serves the JSON on disk, see server.js withSavedCanvasData).
 *
 * Stored exactly where the viewer stores them:
 *   - a line of the window's code          → windows[].lineComments["<line>"]
 *   - an added line of a diff overlay      → windows[].diffState.diffComments["added:<line>"]
 *   - a removed line (old line number)     → windows[].diffState.diffComments["removed:<line>"]
 * (viewer.js buildSaveData / restoreDiffStates / applyDiffOverlayToWindow).
 */
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join('build', 'call-hierarchy-output');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.gradle', '.idea', '.vscode', 'target', 'out', 'dist', '.callcanvas-cache']);
const MAX_SCAN_DEPTH = 6;

/**
 * Canvas JSON files under the project root: the Java / change set output directories
 * (`<module>/build/call-hierarchy-output/callcanvas_*.json`) and the JS/TS ones written at the
 * workspace root (`<root>/*_callcanvas.json`).
 */
function scanCanvasFiles(projectRoot) {
    const found = [];
    const visit = (dir, depth) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'build') {
                    const out = path.join(full, 'call-hierarchy-output');
                    let files = [];
                    try {
                        files = fs.readdirSync(out);
                    } catch { /* no output */ }
                    files.filter(f => f.startsWith('callcanvas_') && f.endsWith('.json'))
                        .forEach(f => found.push(path.join(out, f)));
                    continue;
                }
                if (!SKIP_DIRS.has(entry.name) && depth < MAX_SCAN_DEPTH) {
                    visit(full, depth + 1);
                }
            } else if (depth === 0 && entry.name.endsWith('_callcanvas.json')) {
                found.push(full);
            }
        }
    };
    visit(projectRoot, 0);
    return found;
}

/** The directory windows[].filePath is relative to: the module root above build/, else the JSON's directory. */
function canvasBaseDir(jsonPath) {
    const dir = path.dirname(jsonPath);
    if (dir.endsWith(path.sep + OUTPUT_DIR)) {
        return dir.slice(0, -(OUTPUT_DIR.length + 1));
    }
    return dir;
}

function readCanvas(jsonPath) {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (!data || typeof data !== 'object' || !Array.isArray(data.windows)) {
        throw new Error(`not a CallCanvas JSON (no windows): ${jsonPath}`);
    }
    return data;
}

function codeLines(win) {
    if (Array.isArray(win.code)) {
        return win.code.filter(l => !l.diffType).map(l => l.line);
    }
    const count = String(win.code || '').split('\n').length;
    const start = win.startLine || 1;
    return Array.from({ length: count }, (_, i) => start + i);
}

/**
 * Lines the viewer shows as added / removed for this window: the same rule as
 * applyDiffOverlayToWindow (hunks overlapping the window's range; newStart..newStart+newCount-1 are
 * added, the remove lines are numbered from oldStart).
 */
function diffLines(win, lines) {
    const hunks = win.diffState && Array.isArray(win.diffState.hunks) ? win.diffState.hunks : [];
    const first = lines.length ? lines[0] : Infinity;
    const last = lines.length ? lines[lines.length - 1] : -Infinity;
    const added = [];
    const removed = [];
    for (const hunk of hunks) {
        const insertAt = hunk.newCount > 0 ? hunk.newStart : hunk.newStart + 1;
        const addEnd = hunk.newStart + Math.max(hunk.newCount, 0);
        if (!(addEnd >= first && insertAt <= last + 1)) {
            continue;
        }
        for (let i = 0; i < hunk.newCount; i++) {
            added.push(hunk.newStart + i);
        }
        let old = hunk.oldStart;
        for (const dl of hunk.lines || []) {
            if (dl.type === 'remove') {
                removed.push(old);
            }
            old++;
        }
    }
    return { added, removed };
}

/**
 * A change set window that shows the base (old) content as plain lines — a deleted method or a deleted
 * file (`change.source: "base"`). Its line numbers are old-file numbers and every line is a removed one,
 * but the viewer draws them as ordinary lines (no diff overlay), so comments go to lineComments.
 */
function isBaseContent(win) {
    return !!(win.change && win.change.source === 'base');
}

function windowSummary(win) {
    const lines = codeLines(win);
    const diff = isBaseContent(win) ? { added: [], removed: lines } : diffLines(win, lines);
    return {
        id: win.id,
        displayName: win.displayName,
        filePath: win.filePath,
        startLine: lines.length ? lines[0] : null,
        endLine: lines.length ? lines[lines.length - 1] : null,
        ...(win.windowType ? { windowType: win.windowType } : {}),
        ...(diff.added.length ? { addedLines: diff.added } : {}),
        ...(diff.removed.length ? { removedLines: diff.removed } : {}),
        ...(isBaseContent(win) ? { baseContent: true } : {}),
        comments: currentComments(win),
    };
}

function currentComments(win) {
    const out = {};
    Object.entries(win.lineComments || {}).forEach(([line, text]) => { out[line] = text; });
    const diffComments = (win.diffState && win.diffState.diffComments) || {};
    Object.entries(diffComments).forEach(([key, text]) => { out[key] = text; });
    return out;
}

function canvasKind(data) {
    const changeSet = data.metadata && data.metadata.changeSet;
    if (changeSet) {
        return changeSet.kind === 'workbench' ? 'changeSet:workbench' : `changeSet:${String(changeSet.commit || '').slice(0, 8)}`;
    }
    return 'callHierarchy';
}

/** One canvas for `callcanvas canvases`: what it is and which file lines each window shows. */
function describeCanvas(jsonPath, extra = {}) {
    const data = readCanvas(jsonPath);
    let mtime = null;
    try {
        mtime = fs.statSync(jsonPath).mtime.toISOString();
    } catch { /* gone */ }
    return {
        path: jsonPath,
        kind: canvasKind(data),
        title: (data.windows[0] && data.windows[0].displayName) || path.basename(jsonPath),
        modified: mtime,
        ...extra,
        baseDir: canvasBaseDir(jsonPath),
        windows: data.windows.map(windowSummary),
    };
}

/**
 * The canvases of a project: the ones open in a running host first (newest first, `open: true`,
 * the one the browser follows has `latest: true`), then the other canvas JSON files on disk
 * (newest first).
 */
function listCanvases(projectRoot, openCanvases = []) {
    const seen = new Set();
    const result = [];
    for (const canvas of openCanvases) {
        if (!canvas.jsonPath || seen.has(canvas.jsonPath) || !fs.existsSync(canvas.jsonPath)) {
            continue;
        }
        seen.add(canvas.jsonPath);
        try {
            result.push(describeCanvas(canvas.jsonPath, { open: true, latest: canvas.latest === true }));
        } catch { /* unreadable: skip */ }
    }
    const onDisk = scanCanvasFiles(projectRoot)
        .filter(p => !seen.has(p))
        .map(p => ({ p, t: (() => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } })() }))
        .sort((a, b) => b.t - a.t);
    for (const { p } of onDisk) {
        try {
            result.push(describeCanvas(p, { open: false }));
        } catch { /* not a canvas */ }
    }
    return result;
}

/** `--canvas`: a path to a JSON, or the file name / a unique part of the path of a listed canvas. */
function resolveCanvasArg(arg, canvases) {
    if (!arg) {
        if (!canvases.length) {
            throw new Error('no canvas found (open one with :CallCanvas / :CallCanvasChangeSet first)');
        }
        return canvases[0].path;
    }
    const direct = path.resolve(arg);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
        return direct;
    }
    const matches = canvases.filter(c => c.path === arg || path.basename(c.path) === arg || c.path.includes(arg));
    if (matches.length === 1) {
        return matches[0].path;
    }
    if (matches.length === 0) {
        throw new Error(`no canvas matches "${arg}"`);
    }
    throw new Error(`"${arg}" matches ${matches.length} canvases: ${matches.map(c => path.basename(c.path)).join(', ')}`);
}

function normalize(p) {
    return path.normalize(p).split(path.sep).join('/');
}

/** Does the window show this file? Exact (resolved against the canvas' base dir), else a path-suffix match. */
function sameFile(win, file, baseDir, cwd) {
    if (!win.filePath) {
        return false;
    }
    const winAbs = normalize(path.resolve(baseDir, win.filePath));
    const fileAbs = normalize(path.resolve(cwd, file));
    if (winAbs === fileAbs) {
        return true;
    }
    const winRel = normalize(win.filePath).replace(/^\.\//, '');
    const fileRel = normalize(file).replace(/^\.\//, '');
    return winAbs.endsWith('/' + fileRel) || fileAbs.endsWith('/' + winRel);
}

/**
 * Apply comments to one canvas JSON and write it back.
 *
 * @param {string} jsonPath
 * @param {{file: string, line: number, text?: string, diff?: 'added'|'removed', window?: string}[]} items
 * @param {{remove?: boolean, cwd?: string}} options
 * @returns {{path: string, applied: object[], failed: object[]}}
 */
function applyComments(jsonPath, items, options = {}) {
    const cwd = options.cwd || process.cwd();
    const data = readCanvas(jsonPath);
    const baseDir = canvasBaseDir(jsonPath);
    const applied = [];
    const failed = [];

    for (const item of items) {
        const line = Number(item.line);
        const where = { file: item.file, line, ...(item.diff ? { diff: item.diff } : {}) };
        if (!item.file || !Number.isInteger(line) || line < 1) {
            failed.push({ ...where, error: 'file and a positive line number are required' });
            continue;
        }
        if (item.diff && item.diff !== 'added' && item.diff !== 'removed') {
            failed.push({ ...where, error: `diff must be "added" or "removed" (got "${item.diff}")` });
            continue;
        }
        if (!options.remove && (typeof item.text !== 'string' || item.text.trim() === '')) {
            failed.push({ ...where, error: 'text is required' });
            continue;
        }
        const fileWindows = data.windows.filter(w => sameFile(w, item.file, baseDir, cwd)
            && (!item.window || w.id === item.window));
        if (!fileWindows.length) {
            failed.push({ ...where, error: item.window
                ? `window "${item.window}" does not show ${item.file}`
                : `${item.file} is not on this canvas` });
            continue;
        }
        const targets = [];
        for (const win of fileWindows) {
            const lines = codeLines(win);
            const diff = diffLines(win, lines);
            let kind = null;
            if (isBaseContent(win)) {
                // old-file line numbers: only reachable as a removed line
                kind = item.diff === 'removed' && lines.includes(line) ? 'line' : null;
            } else if (item.diff === 'removed') {
                kind = diff.removed.includes(line) ? 'removed' : null;
            } else if (diff.added.includes(line)) {
                kind = 'added';
            } else if (item.diff !== 'added' && lines.includes(line)) {
                kind = 'line';
            }
            if (kind) {
                targets.push({ win, kind, removed: item.diff === 'removed' });
            }
        }
        if (!targets.length) {
            const ranges = fileWindows.map(w => {
                const s = windowSummary(w);
                return `${s.id} ${s.startLine}-${s.endLine}`
                    + (s.baseContent ? ' (deleted content: old line numbers, use --diff removed)'
                        : s.removedLines ? ` (removed: ${s.removedLines.join(',')})` : '');
            });
            failed.push({ ...where, error: `line ${line} is not shown on this canvas`
                + (item.diff ? ` as a ${item.diff} line` : '') + `; windows of this file: ${ranges.join('; ')}` });
            continue;
        }
        for (const { win, kind, removed } of targets) {
            let previous;
            if (kind === 'line') {
                const map = win.lineComments || {};
                previous = map[String(line)];
                if (options.remove) {
                    delete map[String(line)];
                } else {
                    map[String(line)] = item.text;
                }
                if (Object.keys(map).length) {
                    win.lineComments = map;
                } else {
                    delete win.lineComments;
                }
            } else {
                const key = `${kind}:${line}`;
                const map = win.diffState.diffComments || {};
                previous = map[key];
                if (options.remove) {
                    delete map[key];
                } else {
                    map[key] = item.text;
                }
                if (Object.keys(map).length) {
                    win.diffState.diffComments = map;
                } else {
                    delete win.diffState.diffComments;
                }
            }
            applied.push({
                ...where,
                window: win.id,
                displayName: win.displayName,
                ...(kind !== 'line' ? { diff: kind } : removed ? { diff: 'removed' } : {}),
                ...(previous !== undefined ? { previous } : {}),
                ...(options.remove ? { removed: previous !== undefined } : {}),
            });
        }
    }

    if (applied.length) {
        const tmp = `${jsonPath}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmp, jsonPath);
    }
    return { path: jsonPath, applied, failed };
}

module.exports = { scanCanvasFiles, canvasBaseDir, describeCanvas, listCanvases, resolveCanvasArg, applyComments };
