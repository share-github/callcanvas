#!/usr/bin/env node
/**
 * Golden file test runner for CallCanvas Viewer extension.
 *
 * Tests pure functions extracted from extension.ts without modifying it.
 *
 * Usage:
 *   node test-fixtures/golden/run-test.js           # run tests
 *   node test-fixtures/golden/run-test.js --update   # update expected files
 *   node test-fixtures/golden/run-test.js <name>     # run only matching test case
 */

const fs = require('fs');
const path = require('path');

const goldenDir = __dirname;
const helpersDir = path.resolve(__dirname, '../helpers');
const { loadExtensionHostFunctions, loadWebviewFunctions, loadCoverageParserFunctions, stripTypeAnnotations } = require(path.join(helpersDir, 'load-functions.js'));

const UPDATE = process.argv.includes('--update');
const filterArg = process.argv.find(a => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]);

// Load functions once
let ext, wv, cv;
try {
    ext = loadExtensionHostFunctions();
    wv = loadWebviewFunctions();
    cv = loadCoverageParserFunctions();
} catch (e) {
    console.error('FATAL: Failed to load functions:', e.message);
    process.exit(1);
}

// Registry: maps test directory name → { fn, argBuilder }
// argBuilder converts a test case's `input` into function arguments
const testRegistry = {
    'parse-git-diff-detailed': {
        fn: ext.parseGitDiffDetailed,
        args: (input) => [input.stdout],
    },
    // 変更集合キャンバスの git 層（src/gitUtils.ts）。一時 git リポジトリを子プロセスで作って検証する
    'git-change-set': {
        fn: (input) => require(path.join(helpersDir, 'git-change-set.js')).runScenario(input),
        args: (input) => [input],
    },
    // 変更集合キャンバスの viewer 描画（グループ枠・グループ単位の自動配置・省略接続・保存往復・再解析しない）
    // ← / → のステップ移動: 先頭から末尾までの順・末尾から ← で逆順に戻ること・クリックした行からの再開
    'step-navigation': {
        fn: (input) => {
            const data = { ...input.canvas, windows: input.canvas.windows.map(w => wv.normalizeWindowData(w)) };
            const model = wv.buildStepModel(data);
            const fmt = st => { const p = wv.stepPosition(model, st); return p ? p.windowId + ':' + p.line : null; };
            const walk = (st, step, limit) => {
                const out = [];
                for (let s = st; s && out.length < limit; s = step(model, s)) out.push(fmt(s));
                return out;
            };
            const forward = [];
            let last = null;
            for (let s = wv.stepFirst(model); s && forward.length < 1000; s = wv.stepNext(model, s)) { forward.push(fmt(s)); last = s; }
            const backward = last ? walk(last, wv.stepPrev, 1000) : [];
            const anchors = (input.anchors || []).map(a => {
                const prev = a.after ? (() => {
                    let s = wv.stepFirst(model);
                    for (let i = 0; i < a.after; i++) s = wv.stepNext(model, s);
                    return s;
                })() : null;
                const st = wv.stepStateFromRow(model, prev, a.windowId, a.line);
                const step = a.direction === 'prev' ? wv.stepPrev : wv.stepNext;
                return walk(st && step(model, st), step, a.steps);
            });
            return {
                starts: model.starts,
                forward,
                backwardIsReverse: JSON.stringify(backward) === JSON.stringify(forward.slice().reverse()),
                anchors,
            };
        },
        args: (input) => [input],
    },
    'changeset-canvas': {
        fn: (input) => require(path.join(helpersDir, 'changeset-canvas.js')).runScenario(input, wv),
        args: (input) => [input],
    },
    // 変更集合キャンバスの合成（src/changeSet.ts）。Java の解析結果はモックで与える
    'change-set-compose': {
        fn: (input) => require(path.join(helpersDir, 'change-set.js')).composeAndCheck(input),
        args: (input) => [input],
        clone: true,
    },
    // clientside の島（JS/TS 拡張の resolveMethodSignatures / analyzeMethod / collectIncludeEdges の結果はモック）
    'change-set-clientside': {
        fn: (input) => require(path.join(helpersDir, 'change-set.js')).composeClientside(input),
        args: (input) => [input],
        clone: true,
    },
    'change-set-java-methods': {
        fn: (input) => require(path.join(helpersDir, 'change-set.js')).javaMethods(input),
        args: (input) => [input],
    },
    'change-set-validate': {
        fn: (input) => require(path.join(helpersDir, 'change-set.js')).validate(input),
        args: (input) => [input],
    },
    'extract-method-name': {
        fn: ext.extractMethodName,
        args: (input) => [input.code, input.languageId],
    },
    'extract-fqn-from-filepath': {
        fn: ext.extractFqnFromFilePath,
        args: (input) => [input.filePath],
    },
    'extract-parameter-types': {
        fn: ext.extractParameterTypes,
        args: (input) => [input.code, input.methodName],
    },
    'parse-parameter-list': {
        fn: ext.parseParameterList,
        args: (input) => [input.paramList],
    },
    'remove-generics': {
        fn: ext.removeGenerics,
        args: (input) => [input.type],
    },
    'extract-method-signature': {
        fn: ext.extractMethodSignature,
        args: (input) => [input.displayName, input.code, input.filePath],
    },
    'detect-analysis-language': {
        fn: ext.detectAnalysisLanguage,
        args: (input) => [input.filePath],
    },
    'extract-method-signature-js': {
        fn: ext.extractMethodSignatureJS,
        args: (input) => [input.displayName, input.filePath, input.startLine],
    },
    'calc-window-height': {
        fn: wv.calcWindowHeight,
        args: (input) => [input.lineCount, input.applyMaxLimit],
    },
    'detect-language': {
        fn: wv.detectLanguage,
        args: (input) => [input.filePath],
    },
    'normalize-window': {
        fn: wv.normalizeWindowData,
        args: (input) => [input],
        // normalizeWindowData mutates its argument; deep-clone first
        clone: true,
    },
    'build-save-data': {
        fn: wv.buildSaveData,
        args: (input) => [input],
        clone: true,
    },
    'auto-layout': {
        fn: wv.applyAutoLayout,
        args: (input) => [input],
        clone: true,
        // Strip debug console.log noise from comparison
        postProcess: (result) => result,
    },
    'find-path-windows': {
        fn: wv.findPathWindows,
        args: (input) => [input.currentData, input.rootIds, input.targetIds],
        // findPathWindows returns a Set — convert to sorted array for comparison
        postProcess: (result) => [...result].sort(),
    },
    'find-connections-at-line': {
        fn: wv.findConnectionsAtLine,
        args: (input) => [input.currentData, input.windowId, input.lineNumber, input.omitEndLine],
    },
    'collect-call-origin-line-keys': {
        fn: wv.collectCallOriginLineKeys,
        args: (input) => [input.currentData],
        postProcess: (result) => [...result].sort(),
    },
    'get-window-text': {
        fn: wv.getWindowText,
        args: (input) => [input.windowData],
    },
    'split-highlighted-lines': {
        fn: wv.splitHighlightedLines,
        args: (input) => [input.html],
    },
    'escape-regexp': {
        fn: wv.escapeRegExp,
        args: (input) => [input.string],
    },
    'get-line-count': {
        fn: wv.getLineCount,
        args: (input) => [input.windowData],
    },
    'highlight-text-in-html': {
        fn: wv.highlightTextInHTML,
        // Reproduce actual call path: escapeRegExp(query) → RegExp (see extension.ts:3373-3374)
        args: (input) => [input.html, input.query, new RegExp('(' + wv.escapeRegExp(input.query) + ')', 'gi')],
    },
    'strip-type-annotations': {
        fn: stripTypeAnnotations,
        args: (input) => [input],
    },
    'parse-jacoco-coverage': {
        fn: cv.parseJacocoCoverageFromString,
        args: (input) => [input],
    },
    'find-coverage-for-window': {
        fn: wv.findCoverageForWindow,
        args: (input) => [input.currentCoverage, input.windowData],
    },
    'normalize-display-name-to-class-method': {
        fn: wv.normalizeDisplayNameToClassMethod,
        args: (input) => [input.displayName],
    },
    'extract-method-name-display': {
        fn: wv.extractMethodName,
        args: (input) => [input.displayName],
    },
    'pick-root-window': {
        fn: ext.pickRootWindow,
        args: (input) => [input.windows, input.connections, input.rootWindowId],
    },
    'compute-graph-depth': {
        fn: ext.computeGraphDepth,
        args: (input) => [input.connections, input.rootId],
    },
    'find-declaration-line-offset': {
        fn: ext.findDeclarationLineOffset,
        args: (input) => [input.code],
    },
    'resolve-declaration-line': {
        fn: ext.resolveDeclarationLine,
        args: (input) => [input.windowData],
    },
    'build-reanalysis-plan': {
        fn: ext.buildReanalysisPlan,
        args: (input) => [input.currentJson, input.defaults],
        clone: true,
    },
    'preserve-line-comments': {
        fn: ext.preserveLineComments,
        args: (input) => [input.oldJson, input.newData],
        clone: true,
    },
    'with-analysis-metadata': {
        fn: ext.withAnalysisMetadata,
        args: (input) => [input.data, input.record],
        clone: true,
    },
    'summarize-reanalysis': {
        fn: ext.summarizeReanalysis,
        args: (input) => [input.oldJson, input.newData],
    },
    // ---- Go to Declaration (symbols / refs) ----
    'decorate-code-line-tokens': {
        fn: wv.decorateCodeLineTokens,
        args: (input) => {
            const sym = input.symbolIndex || null;
            const sortedKeys = sym ? Object.keys(sym).sort((a, b) => b.length - a.length) : [];
            return [input.html, input.refs, input.symbols, sym, sortedKeys];
        },
    },
    // Ctrl/⌘+click: the token under the click, else the one pressed at mousedown when the click fell
    // back to .code-line (line nodes replaced by the selection-highlight clear / window moved mid-click)
    'resolve-symbol-ref-click': {
        fn: wv.resolveSymbolRefClick,
        args: (input) => [input.clickSymbol, input.pressed, input.click],
    },
    'compute-window-deletion': {
        fn: wv.computeWindowDeletion,
        args: (input) => [input.connections, input.ids],
        clone: true,
    },
    // Ctrl/⌘+click / "Go to Declaration" on each token: openFile with the declaration's filePath + line
    // is posted, the canvas (save payload) is unchanged; unknown symbol → toast only; Export HTML → nothing.
    'go-to-declaration-flow': {
        fn: (input) => {
            const data = {
                ...input.canvas,
                windows: input.canvas.windows.map(w => wv.normalizeWindowData(w)),
                connections: input.canvas.connections.slice(),
            };
            data._symbolKeys = Object.keys(data.symbolIndex || {}).sort((a, b) => b.length - a.length);
            const before = JSON.stringify(wv.buildSaveData(data));
            const click = (symbolKey, exportMode) => {
                const posted = [];
                const toasts = [];
                wv.goToDeclaration(data, symbolKey, { postMessage: m => posted.push(m) },
                    (msg, type) => toasts.push({ msg, type }), exportMode === true);
                return { symbol: symbolKey, posted, toasts };
            };
            // the symbols a click can reach = the data-symbol of the rendered tokens
            const tokenSymbols = [];
            data.windows.forEach(w => {
                const byLine = wv.groupRefsByLine(w.refs);
                w.code.forEach(line => {
                    const html = wv.decorateCodeLineTokens(line.content, byLine.get(line.line), data.symbols,
                        data.symbolIndex, data._symbolKeys);
                    const re = /data-symbol="([^"]*)"/g;
                    let m;
                    while ((m = re.exec(html)) !== null) tokenSymbols.push(m[1]);
                });
            });
            const clicks = tokenSymbols.map(k => click(k));
            const unknown = click('com.example.Missing');
            const exported = click(tokenSymbols[0], true);
            const after = JSON.stringify(wv.buildSaveData(data));
            return { clicks, unknown, exported, canvasUnchanged: before === after };
        },
        args: (input) => [input],
        clone: true,
    },
    // Analyze Next Level merge: symbols are merged (incoming wins), the source / duplicate windows adopt
    // the result's refs (only when they have none), and symbols + refs survive save → reload (tokens).
    'merge-symbols-flow': {
        fn: (input) => {
            const data = {
                ...input.canvas,
                windows: input.canvas.windows.map(w => wv.normalizeWindowData(w)),
            };
            const changedSymbols = wv.mergeSymbols(data, input.newData);
            const adopted = wv.adoptWindowRefs(data, input.newData, input.idMapping);
            const saved = wv.buildSaveData(data);
            const reloaded = { ...saved, windows: saved.windows.map(w => wv.normalizeWindowData(w)) };
            const rendered = {};
            reloaded.windows.forEach(w => {
                const byLine = wv.groupRefsByLine(w.refs);
                rendered[w.id] = w.code
                    .filter(l => byLine.has(l.line))
                    .map(l => wv.decorateCodeLineTokens(l.content, byLine.get(l.line), reloaded.symbols, null, []));
            });
            return {
                changedSymbols,
                adopted,
                symbolKeys: Object.keys(data.symbols || {}).sort(),
                savedSymbols: saved.symbols || null,
                savedRefs: Object.fromEntries(saved.windows.map(w => [w.id, w.refs || null])),
                renderedAfterReload: rendered,
            };
        },
        args: (input) => [input],
        clone: true,
    },
    // Analyze Next Level / incoming / toRoot merge: the result's symbolIndex is adopted (existing keys
    // win), _symbolKeys is rebuilt so wrapConstantTokens drops its cached regex, and the merged
    // constants survive save → reload.
    'merge-symbol-index-flow': {
        fn: (input) => {
            const data = {
                ...input.canvas,
                windows: input.canvas.windows.map(w => wv.normalizeWindowData(w)),
            };
            data._symbolKeys = Object.keys(data.symbolIndex || {}).sort((a, b) => b.length - a.length);
            const keysBefore = data._symbolKeys;
            const render = (d, line) => wv.wrapConstantTokens(line, d.symbolIndex || {}, d._symbolKeys || []);
            const beforeMerge = render(data, input.newLine);
            const added = wv.mergeSymbolIndex(data, input.newData);
            const afterMerge = render(data, input.newLine);
            const saved = wv.buildSaveData(data);
            const reloaded = { ...saved, windows: saved.windows.map(w => wv.normalizeWindowData(w)) };
            reloaded._symbolKeys = Object.keys(reloaded.symbolIndex || {}).sort((a, b) => b.length - a.length);
            return {
                added,
                symbolKeysRebuilt: data._symbolKeys !== keysBefore,
                symbolKeys: data._symbolKeys,
                symbolIndex: data.symbolIndex || null,
                beforeMerge,
                afterMerge,
                savedSymbolIndex: saved.symbolIndex || null,
                savedHasDerivedKeys: '_symbolKeys' in saved,
                afterReload: render(reloaded, input.newLine),
            };
        },
        args: (input) => [input],
        clone: true,
    },
    // Save → reload keeps symbolIndex, so constant tokens still render after the first save / in Export HTML
    'save-reload-symbol-index': {
        fn: (input) => {
            const data = {
                ...input.canvas,
                windows: input.canvas.windows.map(w => wv.normalizeWindowData(w)),
            };
            data._symbolKeys = Object.keys(data.symbolIndex || {}).sort((a, b) => b.length - a.length);
            const saved = wv.buildSaveData(data);
            const reloaded = { ...saved, windows: saved.windows.map(w => wv.normalizeWindowData(w)) };
            const keys = reloaded.symbolIndex
                ? Object.keys(reloaded.symbolIndex).sort((a, b) => b.length - a.length)
                : [];
            const line = reloaded.windows[0].code.find(l => l.line === input.line).content;
            return {
                savedHasSymbolIndex: 'symbolIndex' in saved,
                savedHasDerivedKeys: '_symbolKeys' in saved,
                savedSymbolKeys: Object.keys(saved.symbols || {}),
                symbolIndexAfterReload: reloaded.symbolIndex || null,
                renderedLine: keys.length > 0 ? wv.wrapConstantTokens(line, reloaded.symbolIndex, keys) : line,
            };
        },
        args: (input) => [input],
        clone: true,
    },
    'wrap-constant-tokens': {
        fn: wv.wrapConstantTokens,
        args: (input) => {
            const sym = input.symbolIndex || {};
            const sortedKeys =
                input.sortedKeys ||
                Object.keys(sym).sort((a, b) => b.length - a.length);
            return [input.htmlContent, sym, sortedKeys];
        },
    },
};

// Discover test case directories
const testDirs = fs.readdirSync(goldenDir)
    .filter(name => {
        const full = path.join(goldenDir, name);
        return fs.statSync(full).isDirectory()
            && (fs.existsSync(path.join(full, 'cases.json'))
                || fs.existsSync(path.join(full, 'input.json')));
    })
    .filter(name => !filterArg || name.includes(filterArg))
    .sort();

if (testDirs.length === 0) {
    console.error('No test cases found' + (filterArg ? ` matching "${filterArg}"` : ''));
    process.exit(1);
}

let passed = 0;
let failed = 0;

for (const dirName of testDirs) {
    const testDir = path.join(goldenDir, dirName);
    const reg = testRegistry[dirName];

    if (!reg) {
        // Check if dirName is a variant of a registered base key (e.g. auto-layout-chain → auto-layout)
        // Find the longest matching registry key that is a prefix of dirName
        let variantReg = null;
        let matchedBase = null;
        for (const key of Object.keys(testRegistry)) {
            if (dirName.startsWith(key + '-') && (!matchedBase || key.length > matchedBase.length)) {
                matchedBase = key;
                variantReg = testRegistry[key];
            }
        }
        if (!variantReg) {
            console.error(`[FAIL]   ${dirName}: no registry entry`);
            failed++;
            continue;
        }
        // Run as variant with input.json / expected.json
        runInputExpected(dirName, testDir, variantReg);
        continue;
    }

    const casesPath = path.join(testDir, 'cases.json');
    const inputPath = path.join(testDir, 'input.json');

    if (fs.existsSync(casesPath)) {
        runCases(dirName, testDir, reg);
    } else if (fs.existsSync(inputPath)) {
        runInputExpected(dirName, testDir, reg);
    }
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
    process.exit(1);
}

// ----- Runners -----

/** Run a cases.json file (array of { input, expected } objects) */
function runCases(dirName, testDir, reg) {
    const casesPath = path.join(testDir, 'cases.json');
    let cases;
    try {
        cases = JSON.parse(fs.readFileSync(casesPath, 'utf-8'));
    } catch (e) {
        console.error(`[ERROR]  ${dirName}: Failed to parse cases.json: ${e.message}`);
        failed++;
        return;
    }

    if (UPDATE) {
        // For cases.json, update expected in-place
        const updated = cases.map((c, idx) => {
            const input = reg.clone ? deepClone(c.input) : c.input;
            let actual = reg.fn(...reg.args(input));
            if (reg.postProcess) actual = reg.postProcess(actual);
            return { ...c, expected: actual };
        });
        fs.writeFileSync(casesPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
        console.log(`[UPDATE] ${dirName} (${cases.length} cases)`);
        passed += cases.length;
        return;
    }

    let allPassed = true;
    for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        const label = c.label || `case[${i}]`;
        const input = reg.clone ? deepClone(c.input) : c.input;
        let actual;
        try {
            actual = reg.fn(...reg.args(input));
        } catch (e) {
            console.error(`[FAIL]   ${dirName}/${label}: threw ${e.message}`);
            failed++;
            allPassed = false;
            continue;
        }

        if (reg.postProcess) actual = reg.postProcess(actual);

        const diff = deepDiff(c.expected, actual);
        if (diff.length === 0) {
            passed++;
        } else {
            console.error(`[FAIL]   ${dirName}/${label}:`);
            for (const d of diff) console.error(`         ${d}`);
            allPassed = false;
            failed++;
        }
    }
    if (allPassed) {
        console.log(`[PASS]   ${dirName} (${cases.length} cases)`);
    }
}

/** Run an input.json + expected.json pair */
function runInputExpected(dirName, testDir, reg) {
    const inputPath = path.join(testDir, 'input.json');
    const expectedPath = path.join(testDir, 'expected.json');

    let input;
    try {
        input = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    } catch (e) {
        console.error(`[ERROR]  ${dirName}: Failed to parse input.json: ${e.message}`);
        failed++;
        return;
    }

    const clonedInput = reg.clone ? deepClone(input) : input;
    let actual;
    try {
        actual = reg.fn(...reg.args(clonedInput));
    } catch (e) {
        console.error(`[FAIL]   ${dirName}: threw ${e.message}`);
        console.error(`         ${e.stack}`);
        failed++;
        return;
    }

    if (reg.postProcess) actual = reg.postProcess(actual);

    if (UPDATE) {
        fs.writeFileSync(expectedPath, JSON.stringify(actual, null, 2) + '\n', 'utf-8');
        console.log(`[UPDATE] ${dirName}`);
        passed++;
        return;
    }

    if (!fs.existsSync(expectedPath)) {
        console.error(`[FAIL]   ${dirName}: expected.json not found. Run with --update to create it.`);
        failed++;
        return;
    }

    let expected;
    try {
        expected = JSON.parse(fs.readFileSync(expectedPath, 'utf-8'));
    } catch (e) {
        console.error(`[FAIL]   ${dirName}: Failed to parse expected.json: ${e.message}`);
        failed++;
        return;
    }

    const diff = deepDiff(expected, actual);
    if (diff.length === 0) {
        console.log(`[PASS]   ${dirName}`);
        passed++;
    } else {
        console.error(`[FAIL]   ${dirName}:`);
        for (const d of diff) console.error(`         ${d}`);
        failed++;
    }
}

// ----- Utilities -----

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/** Compare two values, return array of diff messages (empty = match). */
function deepDiff(expected, actual, path = '') {
    const diffs = [];

    if (expected === actual) return diffs;

    if (expected === null || actual === null || expected === undefined || actual === undefined) {
        if (expected !== actual) {
            diffs.push(`${path || 'root'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
        return diffs;
    }

    if (typeof expected !== typeof actual) {
        diffs.push(`${path || 'root'}: type mismatch — expected ${typeof expected}, got ${typeof actual}`);
        return diffs;
    }

    if (Array.isArray(expected) && Array.isArray(actual)) {
        if (expected.length !== actual.length) {
            diffs.push(`${path || 'root'}: array length — expected ${expected.length}, got ${actual.length}`);
        }
        const len = Math.max(expected.length, actual.length);
        for (let i = 0; i < len; i++) {
            diffs.push(...deepDiff(expected[i], actual[i], `${path}[${i}]`));
        }
        return diffs;
    }

    if (typeof expected === 'object') {
        const allKeys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
        for (const key of allKeys) {
            diffs.push(...deepDiff(expected[key], actual[key], path ? `${path}.${key}` : key));
        }
        return diffs;
    }

    // Primitive
    if (expected !== actual) {
        const expStr = JSON.stringify(expected);
        const actStr = JSON.stringify(actual);
        diffs.push(`${path || 'root'}: expected ${expStr}, got ${actStr}`);
    }

    return diffs;
}
