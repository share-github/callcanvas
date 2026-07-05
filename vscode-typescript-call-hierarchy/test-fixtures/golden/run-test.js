#!/usr/bin/env node
/**
 * Golden file test runner for TypeScript Call Hierarchy analyzer.
 *
 * Usage:
 *   node test-fixtures/golden/run-test.js           # run tests
 *   node test-fixtures/golden/run-test.js --update  # update expected.json files
 *   node test-fixtures/golden/run-test.js <name>    # run only matching test case
 *
 * Each test case directory contains:
 *   config.json    - see schema below
 *   *.ts / *.tsx   - fixture sources
 *   expected.json  - normalized { rootFunction, functions, calls [, symbolIndex] [, rootCodeChecks] }
 *
 * Optional expected.rootCodeChecks (CallCanvas `code` shape for the root function only):
 *   notPrefix  - fail if root snippet starts with this string (e.g. "\\n\\n" after imports)
 *   prefix     - fail if root snippet does not start with this string (e.g. "/**" for TSDoc)
 *
 * Optional expected.calleeCodeChecks — same prefix/notPrefix rules per callee by function name:
 *   [{ "name": "constCallee", "notPrefix": "\\n\\n", "prefix": "/**" }, ...]
 * If two functions share a name, the last one in the analyzer map wins (fixtures should use unique names).
 *
 * Call graph alone does not inspect `code`; use these to lock snippet boundaries.
 *
 * config.json:
 *   tsconfig       - optional, relative path to tsconfig (default: tsconfig.json if file exists)
 *   files          - optional, explicit file list (relative paths) when no tsconfig
 *   compilerOptions- optional, merged into parsed tsconfig options
 *   targetFile     - relative path, cursor file
 *   targetLine     - 1-based line
 *   depth          - optional BFS depth (default 3)
 */

const fs = require('fs');
const path = require('path');

const extensionRoot = path.resolve(__dirname, '../..');
const ts = require(path.join(extensionRoot, 'node_modules', 'typescript'));
const goldenDir = __dirname;
const analyzerPath = path.join(extensionRoot, 'out', 'analyzer.js');

if (!fs.existsSync(analyzerPath)) {
    console.error('ERROR: out/analyzer.js not found. Run: npm run compile');
    process.exit(1);
}

const { createProgram, analyzeCallHierarchy } = require(analyzerPath);

const UPDATE = process.argv.includes('--update');
const filterArg = process.argv.find(a => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]);

const testCases = fs.readdirSync(goldenDir)
    .filter(name => {
        const full = path.join(goldenDir, name);
        return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'config.json'));
    })
    .filter(name => !filterArg || name.includes(filterArg))
    .sort();

if (testCases.length === 0) {
    console.error('No test cases found' + (filterArg ? ` matching "${filterArg}"` : ''));
    process.exit(1);
}

let passed = 0;
let failed = 0;

for (const testName of testCases) {
    const testDir = path.join(goldenDir, testName);
    const configPath = path.join(testDir, 'config.json');
    const expectedPath = path.join(testDir, 'expected.json');

    let config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
        console.error(`[ERROR] ${testName}: Failed to read config.json: ${e.message}`);
        failed++;
        continue;
    }

    const { targetFile, targetLine, depth = 3, files, tsconfig: tsconfigRel, compilerOptions: extraCompilerOptions } = config;

    let projectContext;
    try {
        projectContext = buildProjectContext(testDir, { files, tsconfig: tsconfigRel, extraCompilerOptions });
    } catch (e) {
        console.error(`[ERROR] ${testName}: buildProjectContext failed: ${e.message}`);
        failed++;
        continue;
    }

    const absoluteTarget = path.resolve(testDir, targetFile);

    let callGraph;
    try {
        const program = createProgram(projectContext);
        callGraph = analyzeCallHierarchy(program, absoluteTarget, targetLine, projectContext.rootDir, depth);
    } catch (e) {
        console.error(`[ERROR] ${testName}: Analysis failed: ${e.message}`);
        failed++;
        continue;
    }

    const actual = normalizeCallGraph(callGraph, testDir, absoluteTarget, targetLine);

    if (UPDATE) {
        let prev = {};
        try {
            prev = JSON.parse(fs.readFileSync(expectedPath, 'utf-8'));
        } catch {
            /* no previous file */
        }
        const toWrite = {
            rootFunction: actual.rootFunction,
            functions: actual.functions,
            calls: actual.calls,
        };
        if (actual.symbolIndex !== undefined) {
            toWrite.symbolIndex = actual.symbolIndex;
        }
        if (prev.rootCodeChecks) {
            toWrite.rootCodeChecks = prev.rootCodeChecks;
        }
        if (prev.calleeCodeChecks) {
            toWrite.calleeCodeChecks = prev.calleeCodeChecks;
        }
        fs.writeFileSync(expectedPath, JSON.stringify(toWrite, null, 2) + '\n', 'utf-8');
        console.log(`[UPDATE] ${testName}`);
        passed++;
        continue;
    }

    if (!fs.existsSync(expectedPath)) {
        console.error(`[FAIL]   ${testName}: expected.json not found. Run with --update to create it.`);
        failed++;
        continue;
    }

    let expected;
    try {
        expected = JSON.parse(fs.readFileSync(expectedPath, 'utf-8'));
    } catch (e) {
        console.error(`[FAIL]   ${testName}: Failed to read expected.json: ${e.message}`);
        failed++;
        continue;
    }

    const diff = compareResults(expected, actual);
    if (diff.length === 0) {
        console.log(`[PASS]   ${testName}`);
        passed++;
    } else {
        console.error(`[FAIL]   ${testName}:`);
        for (const line of diff) {
            console.error(`         ${line}`);
        }
        failed++;
    }
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
    process.exit(1);
}

/**
 * @param {string} testDir
 * @param {{ files?: string[], tsconfig?: string, extraCompilerOptions?: object }} opts
 */
function buildProjectContext(testDir, opts) {
    const { files, tsconfig: tsconfigRel, extraCompilerOptions } = opts;
    const defaultTsconfig = path.join(testDir, 'tsconfig.json');
    const useTsconfigPath = tsconfigRel
        ? path.resolve(testDir, tsconfigRel)
        : (fs.existsSync(defaultTsconfig) ? defaultTsconfig : null);

    if (useTsconfigPath && fs.existsSync(useTsconfigPath)) {
        const configFile = ts.readConfigFile(useTsconfigPath, ts.sys.readFile);
        if (configFile.error) {
            throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
        }
        const dir = path.dirname(useTsconfigPath);
        const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dir);
        let compilerOptions = { ...parsed.options, noEmit: true };
        if (extraCompilerOptions && typeof extraCompilerOptions === 'object') {
            compilerOptions = { ...compilerOptions, ...extraCompilerOptions };
        }
        return {
            type: 'tsconfig',
            files: parsed.fileNames,
            rootDir: dir,
            compilerOptions,
        };
    }

    if (!files || !Array.isArray(files) || files.length === 0) {
        throw new Error('Either tsconfig.json in test dir or config.files is required');
    }

    const absoluteFiles = files.map(f => path.resolve(testDir, f));
    let compilerOptions = {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.ReactJSX,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        esModuleInterop: true,
    };
    if (extraCompilerOptions && typeof extraCompilerOptions === 'object') {
        compilerOptions = { ...compilerOptions, ...extraCompilerOptions };
    }
    return {
        type: 'single',
        files: absoluteFiles,
        rootDir: testDir,
        compilerOptions,
    };
}

function declarationAnchor(info) {
    return typeof info.declarationLine === 'number' ? info.declarationLine : info.startLine;
}

function normalizeCallGraph(callGraph, rootDir, targetAbsPath, targetLine) {
    let rootFunction = null;
    let rootCode = null;
    for (const [, info] of callGraph.functions) {
        if (info.absolutePath === targetAbsPath && declarationAnchor(info) === targetLine) {
            rootFunction = info.functionName;
            rootCode = info.code;
            break;
        }
    }
    if (!rootFunction) {
        let earliest = null;
        for (const [, info] of callGraph.functions) {
            if (info.absolutePath === targetAbsPath) {
                if (!earliest || declarationAnchor(info) < declarationAnchor(earliest)) {
                    earliest = info;
                }
            }
        }
        if (earliest) {
            rootFunction = earliest.functionName;
            rootCode = earliest.code;
        }
    }

    const functions = Array.from(callGraph.functions.values())
        .map(f => f.functionName)
        .sort();

    const calls = callGraph.calls
        .map(c => {
            const caller = callGraph.functions.get(c.callerSignature);
            const callee = callGraph.functions.get(c.calleeSignature);
            return caller && callee
                ? { from: caller.functionName, to: callee.functionName }
                : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

    const seenCalls = new Set();
    const dedupedCalls = calls.filter(c => {
        const key = `${c.from}→${c.to}`;
        if (seenCalls.has(key)) return false;
        seenCalls.add(key);
        return true;
    });

    /** @type {Record<string, string>} */
    const codesByName = {};
    for (const [, info] of callGraph.functions) {
        codesByName[info.functionName] = info.code;
    }

    let symbolIndex;
    const rawSym = callGraph.symbolIndex;
    if (rawSym && typeof rawSym === 'object' && Object.keys(rawSym).length > 0) {
        symbolIndex = {};
        for (const k of Object.keys(rawSym).sort()) {
            symbolIndex[k] = rawSym[k];
        }
    }

    const out = { rootFunction, functions, calls: dedupedCalls, rootCode, codesByName };
    if (symbolIndex) {
        out.symbolIndex = symbolIndex;
    }
    return out;
}

function compareResults(expected, actual) {
    const diffs = [];

    if (expected.rootFunction !== actual.rootFunction) {
        diffs.push(`rootFunction: expected "${expected.rootFunction}", got "${actual.rootFunction}"`);
    }

    const expFuncs = new Set(expected.functions);
    const actFuncs = new Set(actual.functions);
    for (const f of expFuncs) {
        if (!actFuncs.has(f)) diffs.push(`Missing function: ${f}`);
    }
    for (const f of actFuncs) {
        if (!expFuncs.has(f)) diffs.push(`Unexpected function: ${f}`);
    }

    const expCallKeys = new Set(expected.calls.map(c => `${c.from}→${c.to}`));
    const actCallKeys = new Set(actual.calls.map(c => `${c.from}→${c.to}`));
    for (const k of expCallKeys) {
        if (!actCallKeys.has(k)) diffs.push(`Missing call: ${k}`);
    }
    for (const k of actCallKeys) {
        if (!expCallKeys.has(k)) diffs.push(`Unexpected call: ${k}`);
    }

    if (expected.symbolIndex !== undefined || actual.symbolIndex !== undefined) {
        const expS = JSON.stringify(expected.symbolIndex || {});
        const actS = JSON.stringify(actual.symbolIndex || {});
        if (expS !== actS) {
            diffs.push(`symbolIndex: expected ${expS}, got ${actS}`);
        }
    }

    const checks = expected.rootCodeChecks;
    if (checks && typeof actual.rootCode === 'string') {
        if (checks.notPrefix != null && actual.rootCode.startsWith(checks.notPrefix)) {
            diffs.push(
                `rootCode: must not start with ${JSON.stringify(checks.notPrefix)}, got ${JSON.stringify(actual.rootCode.slice(0, 48))}…`
            );
        }
        if (checks.prefix != null && !actual.rootCode.startsWith(checks.prefix)) {
            diffs.push(
                `rootCode: must start with ${JSON.stringify(checks.prefix)}, got ${JSON.stringify(actual.rootCode.slice(0, 48))}…`
            );
        }
    } else if (checks && actual.rootCode == null) {
        diffs.push('rootCode: root snippet missing (cannot apply rootCodeChecks)');
    }

    const calleeChecks = expected.calleeCodeChecks;
    if (Array.isArray(calleeChecks) && calleeChecks.length > 0) {
        const byName = actual.codesByName || {};
        for (const c of calleeChecks) {
            if (!c || typeof c.name !== 'string') {
                diffs.push('calleeCodeChecks: invalid entry (missing name)');
                continue;
            }
            const code = byName[c.name];
            if (typeof code !== 'string') {
                diffs.push(`calleeCodeChecks: no code for function "${c.name}"`);
                continue;
            }
            if (c.notPrefix != null && code.startsWith(c.notPrefix)) {
                diffs.push(
                    `callee "${c.name}": must not start with ${JSON.stringify(c.notPrefix)}, got ${JSON.stringify(code.slice(0, 48))}…`
                );
            }
            if (c.prefix != null && !code.startsWith(c.prefix)) {
                diffs.push(
                    `callee "${c.name}": must start with ${JSON.stringify(c.prefix)}, got ${JSON.stringify(code.slice(0, 48))}…`
                );
            }
        }
    }

    return diffs;
}
