/**
 * Change Set Canvas viewer scenarios (golden suite `changeset-canvas`).
 *
 * Uses the contract sample test-fixtures/changeset/sample-contract.json and the webview functions of
 * media/viewer.js: grouped auto layout, group frames, title-bar decoration,
 * save round trip, Analyze Next Level merge, and the "no root re-analysis" guard.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractTopLevelFunctionSimple } = require('./load-functions.js');

const SAMPLE = path.resolve(__dirname, '../changeset/sample-contract.json');
const VIEWER_JS = path.resolve(__dirname, '../../media/viewer.js');

function loadSample() {
    return JSON.parse(fs.readFileSync(SAMPLE, 'utf-8'));
}

function clone(o) {
    return JSON.parse(JSON.stringify(o));
}

/** Canvas as renderVisualization holds it: applyAutoLayout → normalizeWindowData. */
function renderLike(wv, data) {
    const layout = wv.applyAutoLayout(clone(data));
    return { ...layout, windows: layout.windows.map(w => wv.normalizeWindowData(w)) };
}

function rect(w) {
    const h = w.collapsed === true ? 33 : w.position.height;
    return { left: w.position.left, top: w.position.top, right: w.position.left + w.position.width, bottom: w.position.top + h };
}

function frameRect(f) {
    return { left: f.left, top: f.top, right: f.left + f.width, bottom: f.top + f.height };
}

function overlaps(a, b) {
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function contains(outer, inner) {
    return outer.left <= inner.left && outer.top <= inner.top && outer.right >= inner.right && outer.bottom >= inner.bottom;
}

/** Overlapping pairs among items (each { id, r }) whose `key` differs. */
function overlappingPairs(items, key) {
    const pairs = [];
    for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
            if (key && items[i][key] === items[j][key]) continue;
            if (overlaps(items[i].r, items[j].r)) pairs.push(items[i].id + ' x ' + items[j].id);
        }
    }
    return pairs;
}

/** Geometry checks on a laid-out canvas (frames from the windows' current positions). */
function checkGeometry(wv, data) {
    const frames = wv.computeGroupFrames(data.groups, data.windows);
    const byId = new Map(frames.map(f => [f.id, f]));
    const visible = data.windows.filter(w => w.visible !== false);
    const windowItems = visible.map(w => ({ id: w.id, group: w.group, r: rect(w) }));
    const blocks = frames.filter(f => f.depth === 0);
    const islands = frames.filter(f => f.depth === 1);
    return {
        // every window lies inside its own group frame (and the block frame of its island)
        windowsOutsideOwnFrame: visible.filter(w => {
            const f = byId.get(w.group);
            if (!f || !contains(frameRect(f), rect(w))) return true;
            const parent = f.parent ? byId.get(f.parent) : null;
            return f.parent ? !(parent && contains(frameRect(parent), rect(w))) : false;
        }).map(w => w.id),
        // every island frame lies inside its parent block frame
        islandsOutsideBlock: islands.filter(f => !byId.has(f.parent) || !contains(frameRect(byId.get(f.parent)), frameRect(f))).map(f => f.id),
        // windows of different groups never overlap; frames of the same level never overlap
        windowOverlapsAcrossGroups: overlappingPairs(windowItems, 'group'),
        blockFrameOverlaps: overlappingPairs(blocks.map(f => ({ id: f.id, r: frameRect(f) }))),
        islandFrameOverlaps: overlappingPairs(islands.map(f => ({ id: f.id, r: frameRect(f) }))),
        // a non-member window never sits inside an island frame
        foreignWindowsInIslands: islands.flatMap(f => visible
            .filter(w => w.group !== f.id && overlaps(frameRect(f), rect(w)))
            .map(w => f.id + ' ∋ ' + w.id)),
        // blocks are stacked top → bottom in `groups` order
        blockOrderTopToBottom: blocks.slice().sort((a, b) => a.top - b.top).map(f => f.id),
    };
}

/**
 * Sandbox with the viewer globals (currentData / vscode / showToast / DOM stubs) for the functions
 * that use them as is: reanalyzeRoot, mergeCallCanvasData, buildSaveData.
 */
function loadGlobalsSandbox() {
    const src = fs.readFileSync(VIEWER_JS, 'utf-8');
    const names = [
        'calcWindowHeight', 'getLineCount', 'getCommentHeightInLines', 'getCommentHeightPx',
        'getEffectiveLineCountForFullHeight', 'calcFullHeightWindowHeight', 'detectLanguage',
        'applyNestedOmissionsToCodeLines', 'normalizeWindowData', 'detectBackEdgeSet', 'applyAutoLayout',
        'relayoutColumnTops', 'hasCanvasGroups', 'isChangeSetCanvas', 'groupLayoutMetrics',
        'buildGroupLayoutPlan', 'groupWindowHeight', 'layoutGroupUnit', 'layoutGroupedWindows',
        'mergeSymbols', 'adoptWindowRefs', 'mergeSymbolIndex', 'buildSaveData', 'reanalyzeRoot',
        'mergeCallCanvasData', 'findConnectionsAtLine',
    ];
    const code = names.map(n => {
        const f = extractTopLevelFunctionSimple(src, n);
        if (!f) throw new Error('Could not extract webview function: ' + n);
        return f;
    }).join('\n\n');
    const container = { innerHTML: '', appendChild() {}, querySelectorAll: () => [] };
    const sandbox = {
        console, String, Array, Set, Map, Math, Object, Number, JSON, RegExp, Date,
        SETTINGS: { windowWidth: 600, minWindowHeight: 80, maxWindowHeight: 600 },
        TITLE_BAR_HEIGHT: 33, CONTENT_PADDING: 24, LINE_HEIGHT: 20, BOTTOM_BUFFER: 20,
        COMMENT_LINE_HEIGHT_PX: 17, COMMENT_BUBBLE_CHROME_PX: 36,
        IS_EXPORT_MODE: false,
        posted: [],
        toasts: [],
        document: { querySelector: () => container, getElementById: () => null },
        createWindow: () => ({}),
        updateArrows() {}, updateContainerSize() {}, saveData() {}, renderViewportWindows() {},
        rerenderCodeAreas() {}, resetLayout() {}, jumpToWindowWithOrigin() {}, showJumpPopupMenu() {},
    };
    sandbox.vscode = { postMessage: m => sandbox.posted.push(m) };
    sandbox.showToast = (msg, type) => sandbox.toasts.push({ msg, type });
    const script = new vm.Script(
        'var currentData = null; var pendingF12Jump = null;\n' + code +
        '\nfunction __set(d) { currentData = d; }\nfunction __get() { return currentData; }\n',
        { filename: 'changeset-canvas-globals.js' });
    vm.createContext(sandbox);
    script.runInContext(sandbox);
    return sandbox;
}

const scenarios = {
    // Frames: one per non-empty group (5 blocks + 2 islands), blocks before their islands
    frames(wv) {
        const data = renderLike(wv, loadSample());
        const frames = wv.computeGroupFrames(data.groups, data.windows);
        return {
            frameCount: frames.length,
            frames: frames.map(f => ({ id: f.id, kind: f.kind, depth: f.depth, parent: f.parent, label: f.label, windowCount: f.windowCount })),
        };
    },
    // Layout: islands inside the Java block, no overlap across groups, blocks in `groups` order
    layout(wv) {
        const data = renderLike(wv, loadSample());
        return {
            geometry: checkGeometry(wv, data),
            positions: Object.fromEntries(data.windows.map(w => [w.id, { left: w.position.left, top: w.position.top, collapsed: w.collapsed }])),
        };
    },
    // Relayout after expanding the junction / growing a window (diff overlay) keeps the groups apart
    relayout(wv) {
        const data = renderLike(wv, loadSample());
        const junction = data.windows.find(w => w.id === 'w-checkout');
        junction.collapsed = false;
        const grown = data.windows.find(w => w.id === 'w-order-validate');
        grown.position.height = 600;
        const hidden = data.windows.find(w => w.id === 'w-order-css');
        hidden.visible = false;
        wv.layoutGroupedWindows(data.windows.filter(w => w.visible !== false), data.connections, data.groups);
        const frames = wv.computeGroupFrames(data.groups, data.windows);
        return {
            geometry: checkGeometry(wv, data),
            // the hidden window's block has no visible member → no frame
            frameIds: frames.map(f => f.id),
        };
    },
    // Without groups the layout is the plain one (applyAutoLayout output unchanged)
    'no-groups'(wv) {
        const sample = loadSample();
        delete sample.groups;
        const plain = wv.applyAutoLayout(clone(sample));
        return {
            hasGroups: wv.hasCanvasGroups(sample),
            frames: wv.computeGroupFrames(undefined, plain.windows).length,
            // every window in level 0/1 columns from START_Y like any canvas
            lefts: [...new Set(plain.windows.map(w => w.position.left))].sort((a, b) => a - b),
            minTop: Math.min(...plain.windows.map(w => w.position.top)),
        };
    },
    // Title bar: windowType / change.status / change.label; junction is shown expanded (no collapsed)
    decor(wv) {
        const sample = loadSample();
        const out = {};
        sample.windows.forEach(w => {
            const d = wv.buildWindowChangeDecor(w);
            out[w.id] = { classes: d.classes, badges: d.badges.map(b => b.cls + ' | ' + b.text) };
        });
        const junction = clone(sample.windows.find(w => w.windowType === 'junction'));
        delete junction.collapsed;
        const expandedJunction = { ...clone(junction), collapsed: false };
        out._junctionCollapsedByDefault = wv.normalizeWindowData(junction).collapsed;
        out._junctionExplicitlyExpanded = wv.normalizeWindowData(expandedJunction).collapsed;
        return out;
    },
    // Via (unchanged relay on the path): 経由 badge, shown expanded, plain connections, laid out in its island
    via(wv) {
        const sample = loadSample();
        const via = clone(sample.windows.find(w => w.windowType === 'via'));
        const decor = wv.buildWindowChangeDecor(via);
        delete via.collapsed;
        const data = renderLike(wv, sample);
        const frames = wv.computeGroupFrames(data.groups, data.windows);
        const placed = data.windows.find(w => w.id === via.id);
        const island = frames.find(f => f.id === via.group);
        return {
            classes: decor.classes,
            badges: decor.badges.map(b => b.cls + ' | ' + b.text + ' | ' + b.title),
            collapsedByDefault: wv.normalizeWindowData(via).collapsed,
            explicitlyExpanded: wv.normalizeWindowData({ ...via, collapsed: false }).collapsed,
            connections: sample.connections.filter(c => c.from === via.id || c.to === via.id)
                .map(c => ({ from: c.from, to: c.to, callLine: c.callLine })),
            insideIslandFrame: !!island && contains(frameRect(island), rect(placed)),
            geometry: checkGeometry(wv, data),
        };
    },
    // Save → reload → save keeps groups / group / windowType / change / diffState / metadata.changeSet
    'save-roundtrip'(wv) {
        const sample = loadSample();
        const data = renderLike(wv, sample);
        const saved = wv.buildSaveData(data);
        const reloaded = renderLike(wv, saved);
        const saved2 = wv.buildSaveData(reloaded);
        const pick = d => ({
            groups: d.groups,
            windows: d.windows.map(w => ({ id: w.id, group: w.group, windowType: w.windowType, change: w.change, diffState: w.diffState })),
            changeSet: d.metadata && d.metadata.changeSet,
        });
        const orig = JSON.stringify(pick(sample));
        return {
            firstSaveKeepsAll: JSON.stringify(pick(saved)) === orig,
            secondSaveKeepsAll: JSON.stringify(pick(saved2)) === orig,
            savedTopLevelKeys: Object.keys(saved).sort(),
            junctionCollapsedSaved: saved.windows.find(w => w.id === 'w-checkout').collapsed,
            geometryAfterReload: checkGeometry(wv, reloaded),
        };
    },
    // metadata.changeSet → "ルート再解析" posts nothing (toast only); a plain canvas still posts it.
    // Analyze Next Level merge keeps the canvas' groups / metadata and puts new windows in the source's island.
    'no-reanalysis-and-merge'(wv) {
        const sb = loadGlobalsSandbox();
        const sample = loadSample();
        const layout = sb.applyAutoLayout(clone(sample));
        const data = { ...layout, windows: layout.windows.map(w => sb.normalizeWindowData(w)) };
        sb.__set(data);
        sb.reanalyzeRoot();
        const changeSetResult = { posted: sb.posted.slice(), toasts: sb.toasts.map(t => t.type) };

        sb.posted.length = 0;
        sb.toasts.length = 0;
        const plain = clone(data);
        delete plain.metadata.changeSet;
        sb.__set(plain);
        sb.reanalyzeRoot();
        const plainResult = { posted: sb.posted.map(m => m.command), toasts: sb.toasts.length };

        sb.__set(data);
        const src = data.windows.find(w => w.id === 'w-order-save');
        sb.mergeCallCanvasData({
            windows: [
                { id: 'r0', displayName: src.displayName, filePath: src.filePath, startLine: 18, code: 'x' },
                { id: 'r1', displayName: 'JdbcTemplate.update', filePath: 'src/main/java/com/example/db/Jdbc.java', startLine: 5, code: '    void update() {\n    }' },
            ],
            connections: [{ from: 'r0', to: 'r1', callLine: 19 }],
            metadata: { analysis: { rootWindowId: 'r0' } },
        }, src.displayName, src.id);
        const merged = sb.__get();
        const added = merged.windows.find(w => w.displayName === 'JdbcTemplate.update');
        const saved = sb.buildSaveData();
        return {
            changeSet: changeSetResult,
            plain: plainResult,
            merge: {
                addedGroup: added ? added.group : null,
                groupsKept: JSON.stringify(merged.groups) === JSON.stringify(sample.groups),
                changeSetKept: JSON.stringify(merged.metadata.changeSet) === JSON.stringify(sample.metadata.changeSet),
                analysisNotAdopted: !('analysis' in merged.metadata),
                newConnection: merged.connections.some(c => c.from === 'w-order-save' && c.to === (added && added.id)),
                savedGroups: Array.isArray(saved.groups) ? saved.groups.length : null,
                savedChangeFields: saved.windows.filter(w => w.change).length,
                savedChangeSet: !!(saved.metadata && saved.metadata.changeSet),
                island1Members: merged.windows.filter(w => w.group === 'isl-1').length,
                geometryAfterMerge: checkGeometry(wv, merged),
            },
        };
    },
};

function runScenario(input, wv) {
    const fn = scenarios[input.scenario];
    if (!fn) throw new Error('unknown scenario: ' + input.scenario);
    return fn(wv);
}

module.exports = { runScenario };
