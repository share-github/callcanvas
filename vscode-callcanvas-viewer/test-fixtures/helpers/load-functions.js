/**
 * Function extractor for callcanvas-viewer extension.ts
 *
 * Reads the TypeScript source of extension.ts and extracts
 * both Extension-Host-side and Webview-side pure functions
 * so they can be tested in isolation via `vm.runInNewContext()`.
 *
 * IMPORTANT: extension.ts is never modified — we read it as text.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE_FILES = [
    path.resolve(__dirname, '../../src/extension.ts'),
    path.resolve(__dirname, '../../src/gitUtils.ts'),
    path.resolve(__dirname, '../../src/methodExtractor.ts'),
];

const COVERAGE_PARSER_FILE = path.resolve(__dirname, '../../src/coverageParser.ts');

const VIEWER_JS = path.resolve(__dirname, '../../media/viewer.js');

/** Read source files (cached per process) */
let _srcCache = null;
function getSource() {
    if (!_srcCache) {
        _srcCache = SOURCE_FILES
            .filter(f => fs.existsSync(f))
            .map(f => fs.readFileSync(f, 'utf-8'))
            .join('\n\n');
    }
    return _srcCache;
}

/** Read viewer.js (cached per process) */
let _wvCache = null;
function getWebviewSource() {
    if (!_wvCache) {
        _wvCache = fs.readFileSync(VIEWER_JS, 'utf-8');
    }
    return _wvCache;
}

// ---------------------------------------------------------------------------
// A. Extension Host side functions (top-level `function xxx(...)`)
// ---------------------------------------------------------------------------

/**
 * Extract a top-level function body from TypeScript source.
 * Handles `function NAME(... {` with balanced braces.
 */
function extractTopLevelFunction(src, funcName) {
    // Find `function funcName(`  — must be at column 0 (top-level)
    const marker = `function ${funcName}(`;
    let searchFrom = 0;

    while (searchFrom < src.length) {
        const idx = src.indexOf(marker, searchFrom);
        if (idx === -1) return null;

        // Walk backwards to check it's at column 0 (top-level)
        // Allow JSDoc comments before it
        const lineStart = src.lastIndexOf('\n', idx - 1) + 1;
        const indent = src.substring(lineStart, idx);
        // Prefix might be empty or 'export'/'async' — both OK for top-level
        // But if there's significant indentation it's nested
        if (indent.length > 0 && indent.trim().length > 0 && !indent.trim().match(/^(export|async)\s*$/)) {
            // Non-top-level function with same name; scan further
            searchFrom = idx + marker.length;
            continue;
        }

        // Find the opening brace
        let pos = idx;
        while (pos < src.length && src[pos] !== '{') pos++;
        if (pos >= src.length) return null;

        // Balance braces, accounting for strings and template literals
        const body = extractBalancedBraces(src, pos);
        if (!body) return null;

        // Return full function text
        const funcText = src.substring(idx, pos + body.length);
        return funcText;
    }

    return null;
}

/**
 * Extract a top-level function from a plain JS file (e.g. media/viewer.js).
 * Uses the simple brace extractor (no regex parsing) which is safe for
 * functions that contain regex literals with escaped slashes like /\/?span/.
 */
function extractTopLevelFunctionSimple(src, funcName) {
    const marker = `function ${funcName}(`;
    let searchFrom = 0;

    while (searchFrom < src.length) {
        const idx = src.indexOf(marker, searchFrom);
        if (idx === -1) return null;

        const lineStart = src.lastIndexOf('\n', idx - 1) + 1;
        const indent = src.substring(lineStart, idx);
        if (indent.length > 0 && indent.trim().length > 0 && !indent.trim().match(/^(export|async)\s*$/)) {
            searchFrom = idx + marker.length;
            continue;
        }

        let pos = idx;
        while (pos < src.length && src[pos] !== '{') pos++;
        if (pos >= src.length) return null;

        const body = extractBalancedBracesSimple(src, pos);
        if (!body) return null;

        return src.substring(idx, pos + body.length);
    }

    return null;
}


/**
 * Simple brace counter for code inside a TS template literal.
 * Only handles strings (' " ) and line/block comments.
 * Backticks are treated as escaped (no template literal parsing).
 */
function extractBalancedBracesSimple(src, pos) {
    if (src[pos] !== '{') return null;

    let depth = 0;
    let i = pos;
    while (i < src.length) {
        const ch = src[i];

        // Comments
        if (ch === '/' && i + 1 < src.length) {
            if (src[i + 1] === '/') {
                i = src.indexOf('\n', i);
                if (i === -1) i = src.length;
                continue;
            }
            if (src[i + 1] === '*') {
                i = src.indexOf('*/', i + 2);
                if (i === -1) i = src.length;
                else i += 2;
                continue;
            }
        }

        // String literals (single/double quotes)
        if (ch === "'" || ch === '"') {
            i++;
            while (i < src.length && src[i] !== ch) {
                if (src[i] === '\\') i++;
                i++;
            }
            i++;
            continue;
        }

        // Backslash-escaped characters (e.g. \` or \$)
        if (ch === '\\') {
            i += 2;
            continue;
        }

        if (ch === '{') { depth++; i++; continue; }
        if (ch === '}') {
            depth--;
            if (depth === 0) {
                return src.substring(pos, i + 1);
            }
            i++;
            continue;
        }

        i++;
    }
    return null;
}

/**
 * Extract balanced braces starting at src[pos] which must be '{'.
 * Handles strings (' " `), template literals, comments, regex literals, and escapes.
 * Returns the substring from '{' to matching '}'.
 */
function extractBalancedBraces(src, pos) {
    if (src[pos] !== '{') return null;

    let depth = 0;
    let i = pos;
    // Track the last significant token to distinguish regex from division
    let lastToken = '{'; // Starting at '{', so next '/' could be regex
    while (i < src.length) {
        const ch = src[i];

        if (ch === '/' && i + 1 < src.length) {
            // Line comment
            if (src[i + 1] === '/') {
                i = src.indexOf('\n', i);
                if (i === -1) i = src.length;
                continue;
            }
            // Block comment
            if (src[i + 1] === '*') {
                i = src.indexOf('*/', i + 2);
                if (i === -1) i = src.length;
                else i += 2;
                continue;
            }
            // Regex literal: '/' after operator, keyword, '(', '[', '{', ',', ';', '!', '=', ':', '|', '&', '?', 'return', 'new'
            if ('=(!,;:?[{|&+->~'.includes(lastToken) || lastToken === 'return' || lastToken === 'new' || lastToken === '=>') {
                // Skip regex
                i++; // skip opening /
                while (i < src.length && src[i] !== '/') {
                    if (src[i] === '\\') i++; // skip escape
                    if (src[i] === '[') {
                        // Character class — skip until ]
                        i++;
                        while (i < src.length && src[i] !== ']') {
                            if (src[i] === '\\') i++;
                            i++;
                        }
                    }
                    i++;
                }
                i++; // skip closing /
                // Skip flags (g, i, m, s, u, y)
                while (i < src.length && /[gimsuy]/.test(src[i])) i++;
                lastToken = ')'; // regex acts like a value — next '/' is division
                continue;
            }
        }

        // String literals
        if (ch === "'" || ch === '"') {
            i++;
            while (i < src.length && src[i] !== ch) {
                if (src[i] === '\\') i++; // skip escaped char
                i++;
            }
            i++; // skip closing quote
            lastToken = ')'; // string acts like a value
            continue;
        }

        // Template literal
        if (ch === '`') {
            i++;
            let tmplDepth = 0;
            while (i < src.length) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === '`' && tmplDepth === 0) { i++; break; }
                if (src[i] === '$' && i + 1 < src.length && src[i + 1] === '{') {
                    tmplDepth++;
                    i += 2;
                    continue;
                }
                if (src[i] === '}' && tmplDepth > 0) {
                    tmplDepth--;
                    i++;
                    continue;
                }
                i++;
            }
            lastToken = ')'; // template literal acts like a value
            continue;
        }

        if (ch === '{') { depth++; lastToken = '{'; i++; continue; }
        if (ch === '}') {
            depth--;
            if (depth === 0) {
                return src.substring(pos, i + 1);
            }
            lastToken = '}';
            i++;
            continue;
        }

        // Track last significant token for regex detection
        if ('=(!,;:?[|&+->~'.includes(ch)) {
            lastToken = ch;
        } else if (ch === ')' || ch === ']') {
            lastToken = ')';
        } else if (/[a-zA-Z0-9_$]/.test(ch)) {
            // Could be identifier or keyword — read full word
            let word = '';
            let j = i;
            while (j < src.length && /[a-zA-Z0-9_$]/.test(src[j])) {
                word += src[j];
                j++;
            }
            if (word === 'return' || word === 'new' || word === 'typeof' || word === 'instanceof' || word === 'in' || word === 'delete' || word === 'void' || word === 'throw' || word === 'case') {
                lastToken = word;
            } else {
                lastToken = ')'; // identifier acts like a value
            }
            i = j;
            continue;
        } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            // whitespace — don't update lastToken
            i++;
            continue;
        }

        i++;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Strip TypeScript type annotations for evaluation in plain JS
// ---------------------------------------------------------------------------
function stripTypeAnnotations(code) {
    // Remove `: type` parameter annotations — simple heuristic
    // function foo(a: string, b: number): ReturnType {
    // → function foo(a, b) {
    let result = code;

    // Remove return type annotations:  ): string | null {  →  ) {
    result = result.replace(/\)\s*:\s*[^{]+\{/g, (match) => {
        // Keep the ) and {
        return ') {';
    });

    // Remove parameter type annotations within function signature
    // Match `paramName: Type` patterns inside parentheses
    // Handle function declarations
    result = result.replace(/function\s+\w+\s*\(([^)]*)\)/g, (match, params) => {
        const stripped = stripParamTypes(params);
        return match.replace(params, stripped);
    });

    // Remove `as TypeName` casts
    result = result.replace(/\bas\s+\w[\w.<>\[\]|&, ]*(?=[;,)\]\n}])/g, '');

    // Remove TypeScript-only keywords at line level
    // e.g., `const patterns: { [key: string]: RegExp[] } = {`
    // → `const patterns = {`
    result = result.replace(/(const|let|var)\s+(\w+)\s*:\s*[^=]+=\s*/g, '$1 $2 = ');

    return result;
}

function stripParamTypes(params) {
    // Split by comma (respecting generics depth)
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of params) {
        if (ch === '<') { depth++; current += ch; }
        else if (ch === '>') { depth--; current += ch; }
        else if (ch === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) parts.push(current.trim());

    return parts.map(p => {
        // "paramName: Type" or "paramName?: Type"
        const m = p.match(/^(\w+)\??:\s*.+$/);
        if (m) return m[1];
        return p;
    }).join(', ');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load Extension-Host-side functions.
 * Returns an object with function names as keys.
 */
function loadExtensionHostFunctions() {
    const src = getSource();
    const funcNames = [
        'extractMethodName',
        'extractFqnFromFilePath',
        'extractParameterTypes',
        'parseParameterList',
        'removeGenerics',
        'extractMethodSignature',
        'detectAnalysisLanguage',
        'extractMethodSignatureJS',
        'parseGitDiffDetailed',
    ];

    const fns = {};
    const codeFragments = [];

    for (const name of funcNames) {
        const raw = extractTopLevelFunction(src, name);
        if (!raw) {
            throw new Error(`Could not extract top-level function: ${name}`);
        }
        codeFragments.push(stripTypeAnnotations(raw));
    }

    // Some functions call each other (extractMethodSignature → extractFqnFromFilePath etc.)
    // Evaluate them all together in one context.
    const combined = codeFragments.join('\n\n');
    const sandbox = {
        console,
        log: () => {},  // stub for `log()` calls inside functions
    };

    const script = new vm.Script(
        combined + '\n\n' +
        'module.exports = { ' + funcNames.join(', ') + ' };\n',
        { filename: 'extension-host-functions.js' }
    );

    const moduleObj = { exports: {} };
    sandbox.module = moduleObj;
    const ctx = vm.createContext(sandbox);
    script.runInContext(ctx);

    return moduleObj.exports;
}

/**
 * Load coverageParser.ts functions.
 * parseJacocoCoverage reads files via fs; for testing we expose a wrapper
 * parseJacocoCoverageFromString(xmlString) that bypasses file I/O.
 * The returned Map/Map structure is converted to a plain nested object so it
 * can be compared with JSON-serialised expected values.
 */
function loadCoverageParserFunctions() {
    let src = fs.readFileSync(COVERAGE_PARSER_FILE, 'utf-8');

    // Pre-process TypeScript constructs that trip up stripTypeAnnotations:
    // 1. Standalone typed declarations with no initializer: `let m: Type;` → `let m;`
    //    The generic stripTypeAnnotations regex is greedy across lines and would
    //    accidentally consume the subsequent while-loop line.
    src = src.replace(/(let|var)\s+(\w+)\s*:[^;=\n]+;/g, '$1 $2;');
    // 2. Non-null assertions: `expr!.foo` → `expr.foo`
    src = src.replace(/!\./g, '.');

    const raw = extractTopLevelFunction(src, 'parseJacocoCoverage');
    if (!raw) {
        throw new Error('Could not extract parseJacocoCoverage from coverageParser.ts');
    }
    const attrFn = extractTopLevelFunction(src, 'attr');
    if (!attrFn) {
        throw new Error('Could not extract attr from coverageParser.ts');
    }

    const stripped = stripTypeAnnotations(raw);
    const strippedAttr = stripTypeAnnotations(attrFn);

    // Wrapper: call parseJacocoCoverage with a stubbed fs, then convert Map to plain object
    const wrapperCode = `
function parseJacocoCoverageFromString(xmlString) {
    const result = parseJacocoCoverage('__stub__');
    // Convert Map<string, Map<number, obj>> to plain object for JSON comparison
    const out = {};
    for (const [fileKey, lineMap] of result) {
        out[fileKey] = {};
        for (const [lineNr, data] of lineMap) {
            out[fileKey][lineNr] = data;
        }
    }
    return out;
}
`;

    const combined = strippedAttr + '\n\n' + stripped + '\n\n' + wrapperCode;

    const stubFs = {
        readFileSync: (filePath, enc) => {
            // Will be replaced per-call via sandbox mutation
            return sandbox._xmlContent || '';
        }
    };

    const sandbox = {
        console,
        fs: stubFs,
        Map,
        Set,
        Number,
        RegExp,
        _xmlContent: '',
    };

    const script = new vm.Script(
        combined + '\nmodule.exports = { parseJacocoCoverage, parseJacocoCoverageFromString };\n',
        { filename: 'coverage-parser-functions.js' }
    );
    const moduleObj = { exports: {} };
    sandbox.module = moduleObj;
    const ctx = vm.createContext(sandbox);
    script.runInContext(ctx);

    // Wrap parseJacocoCoverageFromString so the caller can pass the XML directly
    const rawExports = moduleObj.exports;
    return {
        parseJacocoCoverageFromString: (xmlString) => {
            // Inject XML into the stubbed fs before calling
            sandbox._xmlContent = xmlString;
            return rawExports.parseJacocoCoverageFromString(xmlString);
        },
    };
}

/**
 * Load Webview-side functions.
 * SETTINGS, calcWindowHeight, getLineCount, etc. are injected as
 * constants / stubs so the extracted functions can execute.
 */
function loadWebviewFunctions(settingsOverride) {
    const src = getWebviewSource();

    const SETTINGS = Object.assign({
        windowWidth: 600,
        minWindowHeight: 80,
        maxWindowHeight: 600,
        jumpToCallTargetKey: 'f12',
    }, settingsOverride || {});

    // Extract all needed webview functions (order: dependencies before callers)
    const webviewFuncNames = [
        'calcWindowHeight',
        'getLineCount',
        'getCommentHeightPx',
        'calcFullHeightWindowHeight',
        'collectCallOriginLineKeys',
        'detectLanguage',
        'applyNestedOmissionsToCodeLines',
        'normalizeWindowData',
        'detectBackEdgeSet',
        'applyAutoLayout',
        'highlightTextInHTML',
        'normalizeDisplayNameToClassMethod',
        'wrapConstantTokens',
        'extractMethodName',
    ];

    const codeFragments = [];
    for (const name of webviewFuncNames) {
        const raw = extractTopLevelFunctionSimple(src, name);
        if (!raw) {
            throw new Error(`Could not extract webview function: ${name}`);
        }
        codeFragments.push(raw);
    }

    // --- Functions that reference `currentData` closure variable ---
    // Patch them to accept currentData as a parameter.

    // buildSaveData() → buildSaveData(currentData)
    const buildSaveDataRaw = extractTopLevelFunctionSimple(src, 'buildSaveData');
    if (!buildSaveDataRaw) {
        throw new Error('Could not extract webview function: buildSaveData');
    }
    const buildSaveDataPatched = buildSaveDataRaw.replace(
        'function buildSaveData()',
        'function buildSaveData(currentData)'
    );
    if (buildSaveDataPatched === buildSaveDataRaw) {
        throw new Error('Patch failed for buildSaveData: signature not found. Has the function signature changed in viewer.js?');
    }
    codeFragments.push(buildSaveDataPatched);

    // findPathWindows(rootIds, targetIds) references currentData.connections
    // → findPathWindows(currentData, rootIds, targetIds)
    const findPathWindowsRaw = extractTopLevelFunctionSimple(src, 'findPathWindows');
    if (!findPathWindowsRaw) {
        throw new Error('Could not extract webview function: findPathWindows');
    }
    const findPathWindowsPatched = findPathWindowsRaw.replace(
        'function findPathWindows(rootIds, targetIds)',
        'function findPathWindows(currentData, rootIds, targetIds)'
    );
    if (findPathWindowsPatched === findPathWindowsRaw) {
        throw new Error('Patch failed for findPathWindows: signature not found. Has the function signature changed in viewer.js?');
    }
    codeFragments.push(findPathWindowsPatched);

    // findConnectionsAtLine(windowId, lineNumber, omitEndLine) references currentData.connections
    // → findConnectionsAtLine(currentData, windowId, lineNumber, omitEndLine)
    const findConnectionsAtLineRaw = extractTopLevelFunctionSimple(src, 'findConnectionsAtLine');
    if (!findConnectionsAtLineRaw) {
        throw new Error('Could not extract webview function: findConnectionsAtLine');
    }
    const findConnectionsAtLinePatched = findConnectionsAtLineRaw.replace(
        'function findConnectionsAtLine(windowId, lineNumber, omitEndLine)',
        'function findConnectionsAtLine(currentData, windowId, lineNumber, omitEndLine)'
    );
    if (findConnectionsAtLinePatched === findConnectionsAtLineRaw) {
        throw new Error('Patch failed for findConnectionsAtLine: signature not found. Has the function signature changed in viewer.js?');
    }
    codeFragments.push(findConnectionsAtLinePatched);

    // getWindowText(windowData) — pure function, no patching needed
    const getWindowTextRaw = extractTopLevelFunctionSimple(src, 'getWindowText');
    if (!getWindowTextRaw) {
        throw new Error('Could not extract webview function: getWindowText');
    }
    codeFragments.push(getWindowTextRaw);

    // splitHighlightedLines(html) — pure function, no patching needed
    const splitHighlightedLinesRaw = extractTopLevelFunctionSimple(src, 'splitHighlightedLines');
    if (!splitHighlightedLinesRaw) {
        throw new Error('Could not extract webview function: splitHighlightedLines');
    }
    codeFragments.push(splitHighlightedLinesRaw);

    // escapeRegExp(string) — pure function, no patching needed
    const escapeRegExpRaw = extractTopLevelFunctionSimple(src, 'escapeRegExp');
    if (!escapeRegExpRaw) {
        throw new Error('Could not extract webview function: escapeRegExp');
    }
    codeFragments.push(escapeRegExpRaw);

    // findCoverageForWindow(windowData) references `currentCoverage` closure variable
    // → findCoverageForWindow(currentCoverage, windowData)
    const findCoverageForWindowRaw = extractTopLevelFunctionSimple(src, 'findCoverageForWindow');
    if (!findCoverageForWindowRaw) {
        throw new Error('Could not extract webview function: findCoverageForWindow');
    }
    const findCoverageForWindowPatched = findCoverageForWindowRaw.replace(
        'function findCoverageForWindow(windowData)',
        'function findCoverageForWindow(currentCoverage, windowData)'
    );
    if (findCoverageForWindowPatched === findCoverageForWindowRaw) {
        throw new Error('Patch failed for findCoverageForWindow: signature not found. Has the function signature changed in viewer.js?');
    }
    codeFragments.push(findCoverageForWindowPatched);

    const combined = codeFragments.join('\n\n');

    const sandbox = {
        console,
        SETTINGS,
        TITLE_BAR_HEIGHT: 33,
        CONTENT_PADDING: 24,
        LINE_HEIGHT: 20,
        // Must match extension.ts webview const BOTTOM_BUFFER (used by calcWindowHeight). Update both when changing.
        BOTTOM_BUFFER: 20,
        COMMENT_LINE_HEIGHT_PX: 17,
        COMMENT_BUBBLE_CHROME_PX: 36,
        String,
        Array,
        Set,
        Map,
        Math,
        Object,
        Number,
        JSON,
        RegExp,
        parseInt,
        parseFloat,
        isNaN,
        undefined,
    };

    const extraFuncNames = [
        'buildSaveData',
        'findPathWindows',
        'findConnectionsAtLine',
        'getWindowText',
        'splitHighlightedLines',
        'escapeRegExp',
        'findCoverageForWindow',
    ];
    const exportNames = [...webviewFuncNames, ...extraFuncNames];
    const script = new vm.Script(
        combined + '\n\n' +
        'module.exports = { ' + exportNames.join(', ') + ' };\n',
        { filename: 'webview-functions.js' }
    );

    const moduleObj = { exports: {} };
    sandbox.module = moduleObj;
    const ctx = vm.createContext(sandbox);
    script.runInContext(ctx);

    return moduleObj.exports;
}

module.exports = {
    loadExtensionHostFunctions,
    loadWebviewFunctions,
    loadCoverageParserFunctions,
    // Exported for testing the helper itself
    extractTopLevelFunction,
    extractTopLevelFunctionSimple,
    stripTypeAnnotations,
};
