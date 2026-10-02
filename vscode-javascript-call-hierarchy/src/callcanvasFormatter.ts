import * as path from 'path';
import { CallGraph, CallCanvasJSON, CallCanvasWindow, CallCanvasConnection, CallCanvasMetadata, CallCanvasAnalysisRecord } from './types';

export interface FormatCallCanvasOptions {
    /** Analysis depth, recorded in metadata.analysis so ルート再解析 can replay it. */
    depth?: number;
}

/**
 * Convert a CallGraph to CallCanvas JSON format compatible with callcanvas-viewer.
 */
export function formatAsCallCanvasJSON(
    callGraph: CallGraph,
    rootSignature: string,
    metadata?: CallCanvasMetadata,
    workspaceRoot?: string,
    options?: FormatCallCanvasOptions
): CallCanvasJSON {
    const windows: CallCanvasWindow[] = [];
    const connections: CallCanvasConnection[] = [];
    const signatureToWindowId = new Map<string, string>();

    // Create windows from functions
    let windowIndex = 0;
    for (const [signature, funcInfo] of callGraph.functions) {
        const windowId = `window-${windowIndex + 1}`;
        signatureToWindowId.set(signature, windowId);

        windows.push({
            id: windowId,
            displayName: funcInfo.displayName,
            filePath: workspaceRoot
                ? path.relative(workspaceRoot, funcInfo.absolutePath)
                : funcInfo.filePath,
            language: detectLanguage(funcInfo.filePath),
            code: funcInfo.code,
            startLine: funcInfo.startLine,
            endLine: funcInfo.endLine,
        });

        windowIndex++;
    }

    // Create connections from calls
    let connectionIndex = 0;
    for (const call of callGraph.calls) {
        const fromId = signatureToWindowId.get(call.callerSignature);
        const toId = signatureToWindowId.get(call.calleeSignature);

        if (fromId && toId) {
            connections.push({
                id: `connection-${connectionIndex + 1}`,
                from: fromId,
                to: toId,
                callLine: call.callLine,
                callEndLine: call.callEndLine,
                ...(call.callEndCol != null ? { callEndCol: call.callEndCol } : {}),
            });
            connectionIndex++;
        }
    }

    const result: CallCanvasJSON = {
        autoLayout: true,
        windows,
        connections,
    };
    const analysis = buildAnalysisRecord(callGraph, rootSignature, workspaceRoot, windows, options);
    if (metadata || analysis) {
        result.metadata = Object.assign({}, metadata || {}, analysis ? { analysis } : {});
    }
    return result;
}

function detectLanguage(filePath: string): string {
    if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(filePath)) {
        return 'javascript';
    }
    return 'javascript';
}

/**
 * Record the analysis that produced this canvas. The Viewer replays it verbatim
 * for "ルート再解析" instead of guessing the root from window order and re-resolving
 * the signature from a line number that may point at the JSDoc block.
 */
function buildAnalysisRecord(
    callGraph: CallGraph,
    rootSignature: string,
    workspaceRoot: string | undefined,
    windows: CallCanvasWindow[],
    options?: FormatCallCanvasOptions
): CallCanvasAnalysisRecord | undefined {
    if (!rootSignature) {
        return undefined;
    }
    const rootInfo = callGraph.functions.get(rootSignature);
    const record: CallCanvasAnalysisRecord = {
        language: 'javascript',
        root: rootSignature,
        direction: 'outgoing',
    };
    if (rootInfo) {
        record.rootFilePath = workspaceRoot
            ? path.relative(workspaceRoot, rootInfo.absolutePath)
            : rootInfo.filePath;
    }
    if (windows.length > 0) {
        record.rootWindowId = windows[0].id;
    }
    if (options && typeof options.depth === 'number') {
        record.depth = options.depth;
    }
    return record;
}
