#!/usr/bin/env node
/**
 * Golden file test runner for JS Call Hierarchy analyzer.
 *
 * Usage:
 *   node test-fixtures/golden/run-test.js           # run tests
 *   node test-fixtures/golden/run-test.js --update  # update expected.json files
 *   node test-fixtures/golden/run-test.js <name>    # run only matching test case
 *
 * Each test case directory contains:
 *   config.json    - { files, targetFile, targetLine, depth }
 *                    or { mode: "resolveLines", files, targetFile, lines } (expected.json: { lines: [{ line, signature }] })
 *   *.js           - JS files to analyze
 *   expected.json  - normalized expected output { rootFunction, functions, calls }
 */

const fs = require('fs');
const path = require('path');

// Resolve paths relative to the extension root
const extensionRoot = path.resolve(__dirname, '../..');
const goldenDir = __dirname;
const analyzerPath = path.join(extensionRoot, 'out', 'analyzer.js');
const resolverPath = path.join(extensionRoot, 'out', 'functionResolver.js');

if (!fs.existsSync(analyzerPath)) {
    console.error('ERROR: out/analyzer.js not found. Run: npm run compile');
    process.exit(1);
}

const { createProgram, analyzeCallHierarchy } = require(analyzerPath);
const { resolveSignaturesAtLines } = require(resolverPath);

// Load template include resolver if available
let collectScriptsFromTemplateTree = null;
const templateResolverPath = path.join(extensionRoot, 'out', 'htmlProjectResolver.js');
if (fs.existsSync(templateResolverPath)) {
    const templateResolver = require(templateResolverPath);
    collectScriptsFromTemplateTree = templateResolver.collectScriptsFromTemplateTree;
}

// Load include map modules if available
let collectIncludeEdges = null;
let formatIncludeMapAsCallCanvasJSON = null;
const includeResolverPath = path.join(extensionRoot, 'out', 'templateIncludeResolver.js');
const includeFormatterPath = path.join(extensionRoot, 'out', 'includeMapFormatter.js');
if (fs.existsSync(includeResolverPath)) {
    collectIncludeEdges = require(includeResolverPath).collectIncludeEdges;
}
if (fs.existsSync(includeFormatterPath)) {
    formatIncludeMapAsCallCanvasJSON = require(includeFormatterPath).formatIncludeMapAsCallCanvasJSON;
}

const UPDATE = process.argv.includes('--update');
const filterArg = process.argv.find(a => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]);

// Discover test cases
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

    const { files, templateFile, targetFile, targetLine, depth = 3, mode, entryFile } = config;

    // --- resolveLines mode: the resolveMethodSignature(s) APIs on a fresh program ---
    if (config.mode === 'resolveLines') {
        let result;
        const resolveContext = { type: 'single', files: (files || []).map(f => path.resolve(testDir, f)), rootDir: testDir };
        try {
            const program = createProgram(resolveContext);
            const signatures = resolveSignaturesAtLines(program, path.resolve(testDir, config.targetFile), config.lines, resolveContext.rootDir);
            result = { lines: (signatures || []).map((signature, i) => ({ line: config.lines[i], signature })) };
        } catch (e) {
            console.error(`[ERROR] ${testName}: resolveSignaturesAtLines failed: ${e.message}`);
            failed++;
            continue;
        }
        if (UPDATE) {
            fs.writeFileSync(expectedPath, JSON.stringify(result, null, 2) + '\n', 'utf-8');
            console.log(`[UPDATE] ${testName}`);
            passed++;
            continue;
        }
        if (!fs.existsSync(expectedPath)) {
            console.error(`[FAIL]   ${testName}: expected.json not found. Run with --update to create it.`);
            failed++;
            continue;
        }
        const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf-8'));
        if (JSON.stringify(expected) === JSON.stringify(result)) {
            console.log(`[PASS]   ${testName}`);
            passed++;
        } else {
            console.error(`[FAIL]   ${testName}:`);
            console.error(`         expected ${JSON.stringify(expected.lines)}`);
            console.error(`         got      ${JSON.stringify(result.lines)}`);
            failed++;
        }
        continue;
    }
    // --- end resolveLines mode ---

    // --- includeMap mode ---
    if (mode === 'includeMap') {
        if (!collectIncludeEdges || !formatIncludeMapAsCallCanvasJSON) {
            console.error(`[ERROR] ${testName}: includeMap modules not found. Run: npm run compile`);
            failed++;
            continue;
        }
        const absoluteEntry = path.resolve(testDir, entryFile);
        let result;
        try {
            const { nodes, edges } = collectIncludeEdges(absoluteEntry, testDir);
            result = normalizeIncludeMap(nodes, edges, testDir);
        } catch (e) {
            console.error(`[ERROR] ${testName}: collectIncludeEdges failed: ${e.message}`);
            failed++;
            continue;
        }

        if (UPDATE) {
            fs.writeFileSync(expectedPath, JSON.stringify(result, null, 2) + '\n', 'utf-8');
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

        const diff = compareIncludeMapResults(expected, result);
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
        continue;
    }
    // --- end includeMap mode ---

    const absoluteTarget = path.resolve(testDir, targetFile);

    // Build ProjectContext and run analysis
    let absoluteFiles;
    if (templateFile && collectScriptsFromTemplateTree) {
        // Template-based project: collect JS files via include tree
        const absoluteTemplate = path.resolve(testDir, templateFile);
        const scripts = collectScriptsFromTemplateTree(absoluteTemplate, testDir);
        absoluteFiles = scripts.map(s => s.absolutePath).filter(f => fs.existsSync(f));
        if (absoluteFiles.length === 0) {
            console.error(`[ERROR] ${testName}: No scripts found via template include tree for ${templateFile}`);
            failed++;
            continue;
        }
    } else {
        absoluteFiles = (files || []).map(f => path.resolve(testDir, f));
    }

    const projectContext = {
        type: templateFile ? 'html' : 'single',
        files: absoluteFiles,
        rootDir: testDir,
    };

    let callGraph;
    try {
        const program = createProgram(projectContext);
        callGraph = analyzeCallHierarchy(program, absoluteTarget, targetLine, testDir, depth);
    } catch (e) {
        console.error(`[ERROR] ${testName}: Analysis failed: ${e.message}`);
        failed++;
        continue;
    }

    // Normalize result: extract only functionName + call pairs
    const actual = normalizeCallGraph(callGraph, testDir, absoluteTarget, targetLine);

    if (UPDATE) {
        fs.writeFileSync(expectedPath, JSON.stringify(actual, null, 2) + '\n', 'utf-8');
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
 * Normalize a CallGraph into a stable, path-independent form.
 * Only functionName is used (not filePath or startLine) to keep expected.json stable.
 */
function normalizeCallGraph(callGraph, rootDir, targetAbsPath, targetLine) {
    // Find the root function (the one at targetLine in the target file)
    let rootFunction = null;
    for (const [, info] of callGraph.functions) {
        if (info.absolutePath === targetAbsPath && info.startLine === targetLine) {
            rootFunction = info.functionName;
            break;
        }
    }
    // Fallback: first function by startLine in target file
    if (!rootFunction) {
        let earliest = null;
        for (const [, info] of callGraph.functions) {
            if (info.absolutePath === targetAbsPath) {
                if (!earliest || info.startLine < earliest.startLine) {
                    earliest = info;
                }
            }
        }
        if (earliest) {
            rootFunction = earliest.functionName;
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

    // Deduplicate calls (same from/to pair)
    const seenCalls = new Set();
    const dedupedCalls = calls.filter(c => {
        const key = `${c.from}→${c.to}`;
        if (seenCalls.has(key)) return false;
        seenCalls.add(key);
        return true;
    });

    return { rootFunction, functions, calls: dedupedCalls };
}

/**
 * Normalize an include map result to a stable, path-independent form.
 * Nodes and edges use relative paths (relative to testDir).
 */
function normalizeIncludeMap(nodes, edges, testDir) {
    const relNodes = nodes
        .map(n => path.relative(testDir, n).replace(/\\/g, '/'))
        .sort();

    const relEdges = edges
        .map(e => ({
            from: path.relative(testDir, e.fromFile).replace(/\\/g, '/'),
            to: path.relative(testDir, e.toFile).replace(/\\/g, '/'),
            line: e.directiveLine,
        }))
        .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

    return { nodes: relNodes, edges: relEdges };
}

/**
 * Compare expected vs actual include map, return array of diff messages (empty = match).
 */
function compareIncludeMapResults(expected, actual) {
    const diffs = [];

    const expNodes = new Set(expected.nodes);
    const actNodes = new Set(actual.nodes);
    for (const n of expNodes) {
        if (!actNodes.has(n)) diffs.push(`Missing node: ${n}`);
    }
    for (const n of actNodes) {
        if (!expNodes.has(n)) diffs.push(`Unexpected node: ${n}`);
    }

    const edgeKey = e => `${e.from}→${e.to}@${e.line}`;
    const expEdgeKeys = new Set((expected.edges || []).map(edgeKey));
    const actEdgeKeys = new Set((actual.edges || []).map(edgeKey));
    for (const k of expEdgeKeys) {
        if (!actEdgeKeys.has(k)) diffs.push(`Missing edge: ${k}`);
    }
    for (const k of actEdgeKeys) {
        if (!expEdgeKeys.has(k)) diffs.push(`Unexpected edge: ${k}`);
    }

    return diffs;
}

/**
 * Compare expected vs actual, return array of diff messages (empty = match).
 */
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

    return diffs;
}
