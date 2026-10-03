/**
 * change-set-* スイート用ヘルパー（変更集合キャンバスの合成 = src/changeSet.ts）。
 *
 * src/changeSet.ts と、それが読む src/gitUtils.ts を TypeScript でその場でトランスパイルして読み込む
 * （out/ の古さに左右されない。'vscode' は空のスタブ）。合成は同期の純粋関数なのでプロセス内で動かす。
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '../..');
const cache = new Map();

function loadTs(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const ts = require(path.join(ROOT, 'node_modules/typescript'));
    const js = ts.transpileModule(fs.readFileSync(file, 'utf-8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
        fileName: file,
    }).outputText;
    const m = new Module(file);
    m.filename = file;
    m.paths = Module._nodeModulePaths(path.dirname(file));
    m.require = (id) => {
        if (id === 'vscode') return {};
        if (id.startsWith('./')) return loadTs(path.join(path.dirname(file), id + '.ts'));
        return require(id);
    };
    cache.set(file, m);
    m._compile(js, file);
    return m.exports;
}

function changeSet() {
    return loadTs(path.join(ROOT, 'src/changeSet.ts'));
}

/** 入力の files にテスト用の既定値を足す（hunks / binary / worktreeMatches） */
function withDefaults(files) {
    return files.map(f => ({ hunks: [], binary: false, worktreeMatches: true, ...f }));
}

/**
 * composeChangeSetCanvas をモックの Java 結果で動かし、不変条件の検査結果と要約を返す。
 * input: { kind ('commit' | 'workbench'、既定 commit), commit, base, files, java }
 */
function composeAndCheck(input) {
    const cs = changeSet();
    const files = withDefaults(input.files);
    const { canvas, javaError } = cs.composeChangeSetCanvas({
        kind: input.kind || 'commit',
        commit: input.kind === 'workbench' || input.kind === 'live' ? null : (input.commit || 'h'.repeat(40)),
        base: input.base || 'b'.repeat(40),
        head: input.kind === 'live' ? (input.head || 't'.repeat(40)) : undefined,
        files,
        java: input.java === undefined ? null : input.java,
    });
    const inputPaths = files.map(f => f.filePath);
    const csMeta = canvas.metadata.changeSet;
    const windowIds = new Set(canvas.windows.map(w => w.id));
    return {
        invariantErrors: cs.validateChangeSetCanvas(canvas, inputPaths),
        // 明示的な確認（validate と独立に）
        allFilesListed: inputPaths.every(p => csMeta.files.filter(f => f.path === p).length === 1) && csMeta.files.length === inputPaths.length,
        allWindowsNonEmptyAndExist: csMeta.files.every(f => f.windows.length > 0 && f.windows.every(id => windowIds.has(id))),
        allGroupsExist: canvas.windows.every(w => canvas.groups.some(g => g.id === w.group)),
        autoLayout: canvas.autoLayout,
        hasAnalysisMetadata: !!canvas.metadata.analysis,
        groups: canvas.groups.map(g => (g.parent ? `${g.kind}:${g.id}<${g.parent}` : `${g.kind}:${g.id}`)),
        windows: canvas.windows.map(w => {
            const o = { group: w.group, windowType: w.windowType || 'method', filePath: w.filePath, startLine: w.startLine };
            if (w.collapsed) o.collapsed = true;
            if (w.change) {
                o.source = w.change.source;
                if (w.change.flags) o.flags = w.change.flags;
                if (w.change.label) o.label = w.change.label;
                if (w.change.oldPath) o.oldPath = w.change.oldPath;
            }
            o.code = typeof w.code === 'string' ? w.code : '';
            o.diffHunks = w.diffState && Array.isArray(w.diffState.hunks) ? w.diffState.hunks.length : 0;
            return o;
        }),
        connections: canvas.connections.length,
        files: csMeta.files.map(f => {
            const o = { path: f.path, status: f.status, block: f.block, inGraph: f.inGraph, windowCount: f.windows.length };
            if (f.oldPath) o.oldPath = f.oldPath;
            if (f.reason) o.reason = f.reason;
            return o;
        }),
        changeSet: csMeta.kind === 'live'
            ? { kind: csMeta.kind, commit: csMeta.commit, base: csMeta.base, head: csMeta.head, keys: Object.keys(csMeta),
                shortName: cs.changeSetShortName(null, csMeta.base) }
            : { kind: csMeta.kind, commit: csMeta.commit },
        symbols: canvas.symbols ? Object.keys(canvas.symbols) : null,
        javaError: javaError ? javaError.replace(/: .*$/, '') : null,
    };
}

/**
 * clientside の島（JS/TS 拡張の結果はモック）。合成した clientside 部分を要約する。
 * input: { files, clientside（ClientsideChangeSetResult か null）, java（省略可） }
 */
function composeClientside(input) {
    const cs = changeSet();
    const files = withDefaults(input.files);
    const { canvas, clientsideError } = cs.composeChangeSetCanvas({
        kind: 'commit',
        commit: 'h'.repeat(40),
        base: 'b'.repeat(40),
        files,
        java: input.java === undefined ? null : input.java,
        clientside: input.clientside === undefined ? null : input.clientside,
    });
    const inputPaths = files.map(f => f.filePath);
    const byId = new Map(canvas.windows.map(w => [w.id, w]));
    const name = (id) => { const w = byId.get(id); return w ? (w.windowType === 'file' ? `file:${w.filePath}` : w.displayName) : `?${id}`; };
    const csMeta = canvas.metadata.changeSet;
    return {
        request: cs.buildClientsideRequest(files),
        invariantErrors: cs.validateChangeSetCanvas(canvas, inputPaths),
        groups: canvas.groups.map(g => (g.parent ? `${g.kind}:${g.id}<${g.parent}` : `${g.kind}:${g.id}`)),
        windows: canvas.windows.filter(w => w.group === 'blk-clientside' || /^cs-isl-/.test(w.group)).map(w => {
            const o = { name: name(w.id), group: w.group, windowType: w.windowType || 'method', filePath: w.filePath, startLine: w.startLine };
            if (w.change) {
                o.status = w.change.status;
                o.source = w.change.source;
                if (w.change.flags) o.flags = w.change.flags;
                if (w.change.label) o.label = w.change.label;
                if (w.change.oldPath) o.oldPath = w.change.oldPath;
            } else {
                o.change = null;
            }
            o.code = typeof w.code === 'string' ? w.code : '';
            o.diffHunks = w.diffState && Array.isArray(w.diffState.hunks) ? w.diffState.hunks.map(h => `+${h.newStart},${h.newCount}`) : [];
            return o;
        }),
        connections: canvas.connections.map(c => `${name(c.from)} -> ${name(c.to)}${c.callLine !== undefined ? ' @' + c.callLine : ''}`),
        files: csMeta.files.filter(f => f.block === 'clientside').map(f => {
            const o = { path: f.path, inGraph: f.inGraph, windows: f.windows.map(name) };
            if (f.reason) o.reason = f.reason;
            return o;
        }),
        symbolIndex: canvas.symbolIndex ? Object.keys(canvas.symbolIndex) : null,
        clientsideError: clientsideError || null,
    };
}

/** extractJavaMethods / findDeletedMethods */
function javaMethods(input) {
    const cs = changeSet();
    if (input.newContent !== undefined) {
        return cs.findDeletedMethods(input.baseContent, input.newContent).map(m => ({ key: m.key, startLine: m.startLine, endLine: m.endLine }));
    }
    return cs.extractJavaMethods(input.content).map(m => ({ key: m.key, startLine: m.startLine, endLine: m.endLine }));
}

/** 不変条件の検査そのもの（壊したキャンバスで違反を検出できること） */
function validate(input) {
    return changeSet().validateChangeSetCanvas(input.canvas, input.inputPaths);
}

module.exports = { composeAndCheck, composeClientside, javaMethods, validate };
