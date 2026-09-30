/**
 * Root re-analysis planning (pure logic, no vscode API).
 *
 * "ルート再解析" used to assume `windows[0]` is the root and always re-ran an
 * outgoing analysis with the config depth. That silently produced a wrong (or
 * empty) canvas whenever:
 *   - windows[0] was not the graph entry (callers merged in, root window deleted)
 *   - the window's `startLine` pointed at the Javadoc/annotation block instead of
 *     the declaration, so signature resolution fell back to a regex guess
 *   - the original export used a different depth/direction than the current config
 *
 * The fix records the analysis that produced the canvas in `metadata.analysis`
 * and replays it verbatim. For canvases exported before that field existed the
 * plan is inferred from the graph itself (entry window + observed depth).
 *
 * NOTE: these functions are extracted as plain JS by the golden test harness
 * (test-fixtures/helpers/load-functions.js), so keep them free of generic type
 * arguments on expressions (`new Map<K, V>()`), non-null assertions and typed
 * arrow parameters — annotate the declaration instead.
 */

/** What produced (or will reproduce) a canvas. Persisted as `metadata.analysis`. */
export interface AnalysisRecord {
    /** 'java' | 'typescript' | 'javascript' */
    language?: string;
    /** Fully resolved root method signature passed to the analyzer. */
    root?: string;
    /** Class FQN for class-level exports (mutually exclusive with `root`). */
    rootClass?: string;
    /** Source file the root lives in (as stored in the canvas: repo-relative or absolute). */
    rootFilePath?: string;
    /** Window id of the root at export time (best-effort hint). */
    rootWindowId?: string;
    /** 'outgoing' | 'incoming' */
    direction?: string;
    /** Analysis depth (-1 = recursive to root). */
    depth?: number;
}

/** Outcome of one language-specific re-analysis attempt. */
export interface ReanalysisResult {
    success: boolean;
    /** Fresh CallCanvas JSON (only when success). */
    data?: any;
    error?: string;
    /** Signature actually used — recorded back into metadata so renames self-heal. */
    signature?: string;
}

export interface ReanalysisPlan {
    /** Window treated as the canvas root (used for language/path/fallback resolution). */
    rootWindow: any;
    /** Recorded signature to replay, or null when it must be resolved from source. */
    methodSignature: string | null;
    /** Recorded class FQN for class-level canvases, or null. */
    rootClass: string | null;
    /** File path of the root as stored in the canvas (relative or absolute). */
    rootFilePath: string;
    direction: string;
    depth: number;
    /** Line to hand to `resolveMethodSignature` — the declaration, not the Javadoc. */
    declLine: number;
    /** 'metadata' when replayed from a recorded analysis, 'inferred' otherwise. */
    source: string;
}

/** The `metadata.analysis` record of a canvas, or an empty record. */
export function readAnalysisRecord(currentJson: any): AnalysisRecord {
    const metadata = currentJson && currentJson.metadata;
    if (metadata && typeof metadata === 'object' && metadata.analysis && typeof metadata.analysis === 'object') {
        return metadata.analysis;
    }
    return {};
}

/**
 * Pick the window the canvas is rooted at.
 *
 * Priority: recorded window id → windows[0] when it is a graph entry (the CLI
 * emits the root first) → first entry window (handles canvases where callers
 * were merged in above the original root) → windows[0] (fully cyclic graphs).
 */
export function pickRootWindow(windows: any[], connections: any[], rootWindowId?: string): any {
    if (!Array.isArray(windows) || windows.length === 0) {
        return null;
    }
    if (rootWindowId) {
        const recorded = windows.find(w => w.id === rootWindowId);
        if (recorded) {
            return recorded;
        }
    }

    // Ids that are the target of at least one non-self connection.
    const incoming: Set<string> = new Set();
    if (Array.isArray(connections)) {
        for (const conn of connections) {
            if (conn && conn.from !== conn.to) {
                incoming.add(conn.to);
            }
        }
    }
    // Field declaration windows (added by the Viewer) are never a method root.
    function isEntry(w: any): boolean {
        return !incoming.has(w.id) && w.windowType !== 'field';
    }

    if (isEntry(windows[0])) {
        return windows[0];
    }
    const visibleEntry = windows.find(w => isEntry(w) && w.visible !== false);
    if (visibleEntry) {
        return visibleEntry;
    }
    const anyEntry = windows.find(isEntry);
    if (anyEntry) {
        return anyEntry;
    }
    return windows[0];
}

/**
 * Longest path (in hops) from `rootId` following connections. Cycle-safe.
 * Used so re-analysing a canvas exported with a deeper setting than the current
 * config does not silently shrink it.
 */
export function computeGraphDepth(connections: any[], rootId: string): number {
    if (!Array.isArray(connections) || connections.length === 0 || !rootId) {
        return 0;
    }
    const adjacency: Map<string, string[]> = new Map();
    for (const conn of connections) {
        // fieldRef edges point at field declarations, not callees: they are not call depth
        if (!conn || conn.from === conn.to || conn.kind === 'fieldRef') {
            continue;
        }
        const children = adjacency.get(conn.from);
        if (children) {
            children.push(conn.to);
        } else {
            adjacency.set(conn.from, [conn.to]);
        }
    }

    let maxDepth = 0;
    const visited: Set<string> = new Set();
    visited.add(rootId);
    let frontier = [rootId];
    while (frontier.length > 0) {
        const next: string[] = [];
        for (const id of frontier) {
            const children = adjacency.get(id) || [];
            for (const child of children) {
                if (!visited.has(child)) {
                    visited.add(child);
                    next.push(child);
                }
            }
        }
        if (next.length > 0) {
            maxDepth++;
        }
        frontier = next;
    }
    return maxDepth;
}

/** Window code (string or `[{line, content}]`) as a list of raw text lines. */
function toCodeLines(code: any): string[] {
    if (typeof code === 'string') {
        return code.split(String.fromCharCode(10));
    }
    if (Array.isArray(code)) {
        return code.map(line => (line && typeof line.content === 'string' ? line.content : ''));
    }
    return [];
}

/** Window code as a single string (canvas JSON stores either form). */
export function codeToString(code: any): string {
    if (typeof code === 'string') {
        return code;
    }
    return toCodeLines(code).join(String.fromCharCode(10));
}

function countParenDelta(text: string): number {
    let delta = 0;
    for (const ch of text) {
        if (ch === '(') {
            delta++;
        } else if (ch === ')') {
            delta--;
        }
    }
    return delta;
}

/**
 * Offset (0-based, within the snippet) of the actual declaration line.
 *
 * The exporter starts a window at the Javadoc / line-comment block above the
 * method (OutputGenerator#findCommentStartLine), and JavaParser reports
 * annotations as part of the declaration. Signature resolvers only look at the
 * line they are given plus a few neighbours, so handing them the stored
 * `startLine` misses the declaration whenever that block is longer than that.
 */
export function findDeclarationLineOffset(code: any): number {
    const lines = toCodeLines(code);
    let inBlockComment = false;
    let annotationDepth = 0;

    for (let i = 0; i < lines.length; i++) {
        const text = (lines[i] || '').trim();

        if (inBlockComment) {
            if (text.indexOf('*/') >= 0) {
                inBlockComment = false;
                const after = text.substring(text.lastIndexOf('*/') + 2).trim();
                if (after.length > 0 && annotationDepth === 0 && after.charAt(0) !== '@') {
                    return i;
                }
            }
            continue;
        }

        // Continuation lines of a multi-line annotation / decorator argument list
        if (annotationDepth > 0) {
            annotationDepth += countParenDelta(text);
            continue;
        }

        if (text.length === 0 || text.indexOf('//') === 0) {
            continue;
        }
        if (text.indexOf('/*') === 0) {
            if (text.indexOf('*/') < 0) {
                inBlockComment = true;
            }
            continue;
        }
        if (text.charAt(0) === '@') {
            const delta = countParenDelta(text);
            annotationDepth = delta > 0 ? delta : 0;
            continue;
        }
        return i;
    }
    return 0;
}

/** Absolute source line of the declaration for a window. */
export function resolveDeclarationLine(windowData: any): number {
    if (!windowData) {
        return 1;
    }
    const offset = findDeclarationLineOffset(windowData.code);
    if (Array.isArray(windowData.code) && windowData.code[offset] && typeof windowData.code[offset].line === 'number') {
        return windowData.code[offset].line;
    }
    const startLine = typeof windowData.startLine === 'number' ? windowData.startLine : 1;
    return startLine + offset;
}

/**
 * Build the plan for "ルート再解析" from the canvas on disk.
 * `defaults.depth` is the language config depth, used only when the canvas has
 * no recorded analysis.
 */
export function buildReanalysisPlan(currentJson: any, defaults: any): ReanalysisPlan | null {
    const windows = (currentJson && Array.isArray(currentJson.windows)) ? currentJson.windows : [];
    if (windows.length === 0) {
        return null;
    }
    const connections = (currentJson && Array.isArray(currentJson.connections)) ? currentJson.connections : [];
    const recorded: AnalysisRecord = readAnalysisRecord(currentJson);

    const rootWindow = pickRootWindow(windows, connections, recorded.rootWindowId);
    const hasRecordedRoot = typeof recorded.root === 'string' && recorded.root.length > 0;
    const hasRecordedClass = typeof recorded.rootClass === 'string' && recorded.rootClass.length > 0;

    const defaultDepth = (defaults && typeof defaults.depth === 'number') ? defaults.depth : 5;
    let depth = defaultDepth;
    if (typeof recorded.depth === 'number' && recorded.depth !== 0) {
        depth = recorded.depth;
    } else {
        // Never shrink a canvas that was exported deeper than the current config.
        const observed = computeGraphDepth(connections, rootWindow ? rootWindow.id : '');
        depth = defaultDepth > observed ? defaultDepth : observed;
    }

    const recordedPath = (typeof recorded.rootFilePath === 'string' && recorded.rootFilePath.length > 0)
        ? recorded.rootFilePath
        : '';
    const rootFilePath = recordedPath || (rootWindow ? rootWindow.filePath : '');

    return {
        rootWindow,
        methodSignature: hasRecordedRoot && recorded.root ? recorded.root : null,
        rootClass: hasRecordedClass && recorded.rootClass ? recorded.rootClass : null,
        rootFilePath,
        direction: (recorded.direction === 'incoming') ? 'incoming' : 'outgoing',
        depth,
        declLine: resolveDeclarationLine(rootWindow),
        source: (hasRecordedRoot || hasRecordedClass) ? 'metadata' : 'inferred'
    };
}

/** Stable identity of a window across analyses (window ids are regenerated per run). */
function windowKey(w: any): string {
    return (w && w.filePath ? w.filePath : '') + '|' + (w && w.displayName ? w.displayName : '');
}

/** First/last source line covered by a window. */
function windowLineRange(w: any): number[] {
    if (Array.isArray(w.code) && w.code.length > 0) {
        const firstEntry = w.code[0];
        const lastEntry = w.code[w.code.length - 1];
        const first = typeof firstEntry.line === 'number' ? firstEntry.line : 1;
        const last = typeof lastEntry.line === 'number' ? lastEntry.line : first;
        return [first, last];
    }
    const start = typeof w.startLine === 'number' ? w.startLine : 1;
    const lines = toCodeLines(w.code);
    const span = lines.length > 0 ? lines.length - 1 : 0;
    return [start, start + span];
}

/**
 * Carry hand-authored line comments from the previous canvas into the freshly
 * analysed one. Comments whose line is no longer inside the window (the source
 * moved) are dropped rather than pinned to an unrelated line.
 */
export function preserveLineComments(oldJson: any, newData: any): any {
    const oldWindows = (oldJson && Array.isArray(oldJson.windows)) ? oldJson.windows : [];
    const newWindows = (newData && Array.isArray(newData.windows)) ? newData.windows : [];
    if (oldWindows.length === 0 || newWindows.length === 0) {
        return newData;
    }

    const commentsByKey: Map<string, any> = new Map();
    for (const w of oldWindows) {
        if (w && w.lineComments && Object.keys(w.lineComments).length > 0) {
            commentsByKey.set(windowKey(w), w.lineComments);
        }
    }
    if (commentsByKey.size === 0) {
        return newData;
    }

    for (const w of newWindows) {
        const carried = commentsByKey.get(windowKey(w));
        if (!carried) {
            continue;
        }
        const range = windowLineRange(w);
        const kept: any = {};
        for (const lineKey of Object.keys(carried)) {
            const lineNumber = parseInt(lineKey, 10);
            if (!isNaN(lineNumber) && lineNumber >= range[0] && lineNumber <= range[1]) {
                kept[lineKey] = carried[lineKey];
            }
        }
        if (Object.keys(kept).length > 0) {
            w.lineComments = Object.assign({}, kept, w.lineComments || {});
        }
    }
    return newData;
}

/**
 * Carry the field declaration windows the user opened (windowType 'field', added by the Viewer)
 * into the freshly analysed canvas. A declaration window survives when a window that referenced
 * it (fieldRef connection) is reproduced (same windowKey) and still has a fieldRef to that field;
 * its code is refreshed from the new `fields` entry (old entry as fallback) and the connection is
 * re-pointed at the reference line in the new analysis. Position is dropped so auto layout places it.
 */
export function preserveFieldWindows(oldJson: any, newData: any): any {
    const oldWindows = (oldJson && Array.isArray(oldJson.windows)) ? oldJson.windows : [];
    const oldConnections = (oldJson && Array.isArray(oldJson.connections)) ? oldJson.connections : [];
    if (!newData || !Array.isArray(newData.windows) || newData.windows.length === 0) {
        return newData;
    }
    const fieldWindows: any[] = [];
    for (const w of oldWindows) {
        if (w && w.windowType === 'field' && w.field) {
            fieldWindows.push(w);
        }
    }
    if (fieldWindows.length === 0) {
        return newData;
    }

    const oldById: Map<string, any> = new Map();
    for (const w of oldWindows) {
        oldById.set(w.id, w);
    }
    const newByKey: Map<string, any> = new Map();
    const usedIds: Set<string> = new Set();
    for (const w of newData.windows) {
        usedIds.add(w.id);
        if (w.windowType !== 'field' && !newByKey.has(windowKey(w))) {
            newByKey.set(windowKey(w), w);
        }
    }
    const oldFields = (oldJson && oldJson.fields) ? oldJson.fields : {};
    const newFields = (newData.fields && typeof newData.fields === 'object') ? newData.fields : {};
    if (!Array.isArray(newData.connections)) {
        newData.connections = [];
    }

    for (const fw of fieldWindows) {
        const entry = newFields[fw.field] || oldFields[fw.field];
        if (!entry) {
            continue;
        }
        let carriedId = fw.id;
        for (let n = 2; usedIds.has(carriedId); n++) {
            carriedId = fw.id + '-' + n;
        }
        const carried: any[] = [];
        for (const conn of oldConnections) {
            if (!conn || conn.kind !== 'fieldRef' || conn.to !== fw.id) {
                continue;
            }
            const oldSource = oldById.get(conn.from);
            // (no `cond ? f(x) : y` here: the golden harness strips `) : ...{` as a return type)
            let newSource: any = undefined;
            if (oldSource) {
                newSource = newByKey.get(windowKey(oldSource));
            }
            const refLines: number[] = [];
            if (newSource && Array.isArray(newSource.fieldRefs)) {
                for (const r of newSource.fieldRefs) {
                    if (r && r.field === fw.field && typeof r.line === 'number') {
                        refLines.push(r.line);
                    }
                }
            }
            if (refLines.length === 0) {
                continue;
            }
            const line = refLines.indexOf(conn.callLine) >= 0 ? conn.callLine : refLines[0];
            let duplicate = false;
            for (const c of carried) {
                if (c.from === newSource.id && c.callLine === line) {
                    duplicate = true;
                }
            }
            if (!duplicate) {
                carried.push({ from: newSource.id, to: carriedId, callLine: line, callEndLine: line, kind: 'fieldRef' });
            }
        }
        if (carried.length === 0) {
            continue;
        }
        if (!newFields[fw.field]) {
            newFields[fw.field] = entry;
        }
        const win: any = {
            id: carriedId,
            windowType: 'field',
            field: fw.field,
            displayName: entry.displayName || fw.displayName || fw.field,
            filePath: entry.filePath,
            startLine: entry.startLine || 1,
            code: entry.code || '',
            collapsed: fw.collapsed === true,
            visible: fw.visible !== false,
            fullHeight: fw.fullHeight === true
        };
        if (fw.lineComments) {
            // Same rule as preserveLineComments: drop comments that fall outside the refreshed code
            const range = windowLineRange(win);
            const kept: any = {};
            for (const lineKey of Object.keys(fw.lineComments)) {
                const lineNumber = parseInt(lineKey, 10);
                if (!isNaN(lineNumber) && lineNumber >= range[0] && lineNumber <= range[1]) {
                    kept[lineKey] = fw.lineComments[lineKey];
                }
            }
            if (Object.keys(kept).length > 0) {
                win.lineComments = kept;
            }
        }
        newData.windows.push(win);
        usedIds.add(carriedId);
        for (const c of carried) {
            newData.connections.push(c);
        }
    }
    if (Object.keys(newFields).length > 0) {
        newData.fields = newFields;
    }
    return newData;
}

/**
 * Stamp the analysis that produced `data` so the next ルート再解析 can replay it
 * exactly, even if the canvas is later edited or re-rooted by the user.
 */
export function withAnalysisMetadata(data: any, record: AnalysisRecord): any {
    if (!data || typeof data !== 'object') {
        return data;
    }
    const hasMeta = data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata);
    const existing = hasMeta ? data.metadata : {};
    const analysis = Object.assign({}, existing.analysis || {}, record);
    if (Array.isArray(data.windows) && data.windows.length > 0 && data.windows[0].id) {
        analysis.rootWindowId = data.windows[0].id;
    }
    data.metadata = Object.assign({}, existing, { analysis });
    return data;
}

/** Window-count comparison used for the completion message. */
export function summarizeReanalysis(oldJson: any, newData: any): any {
    const oldWindows = (oldJson && Array.isArray(oldJson.windows)) ? oldJson.windows : [];
    const newWindows = (newData && Array.isArray(newData.windows)) ? newData.windows : [];
    const oldKeys: Set<string> = new Set();
    const newKeys: Set<string> = new Set();
    for (const w of oldWindows) {
        oldKeys.add(windowKey(w));
    }
    for (const w of newWindows) {
        newKeys.add(windowKey(w));
    }
    let added = 0;
    let removed = 0;
    for (const key of newKeys) {
        if (!oldKeys.has(key)) {
            added++;
        }
    }
    for (const key of oldKeys) {
        if (!newKeys.has(key)) {
            removed++;
        }
    }
    return { total: newWindows.length, previous: oldWindows.length, added, removed };
}
