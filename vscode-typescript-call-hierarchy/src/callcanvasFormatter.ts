import * as path from 'path';
import {
    CallGraph,
    CallCanvasJSON,
    CallCanvasWindow,
    CallCanvasConnection,
    CallCanvasMetadata,
    SymbolEntry,
} from './types';
import { computeNestedOmissionsByParentSignature } from './parentNestedOmit';

export interface FormatCallCanvasOptions {
    /** When true (default), parent windows include `nestedOmissions` for Viewer to render gray cards. */
    parentNestedOmitDisplay?: boolean;
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

    const parentNestedOmit = options?.parentNestedOmitDisplay !== false;
    const omissionsByParent = parentNestedOmit
        ? computeNestedOmissionsByParentSignature(callGraph)
        : new Map();

    // Create windows from functions
    let windowIndex = 0;
    for (const [signature, funcInfo] of callGraph.functions) {
        const windowId = `window-${windowIndex + 1}`;
        signatureToWindowId.set(signature, windowId);

        const nestedOmissions = omissionsByParent.get(signature);
        const win: CallCanvasWindow = {
            id: windowId,
            displayName: funcInfo.displayName,
            filePath: workspaceRoot
                ? path.relative(workspaceRoot, funcInfo.absolutePath)
                : funcInfo.filePath,
            language: detectLanguage(funcInfo.filePath),
            code: funcInfo.code,
            startLine: funcInfo.startLine,
            endLine: funcInfo.endLine,
        };
        if (nestedOmissions && nestedOmissions.length > 0) {
            win.nestedOmissions = nestedOmissions;
        }
        windows.push(win);

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
            });
            connectionIndex++;
        }
    }

    const result: CallCanvasJSON = {
        autoLayout: true,
        windows,
        connections,
    };
    if (metadata) {
        result.metadata = metadata;
    }
    const sym = callGraph.symbolIndex;
    if (sym && Object.keys(sym).length > 0) {
        result.symbolIndex = sortSymbolIndex(sym);
    }
    return result;
}

function sortSymbolIndex(sym: Record<string, SymbolEntry>): Record<string, SymbolEntry> {
    const out: Record<string, SymbolEntry> = {};
    for (const k of Object.keys(sym).sort()) {
        out[k] = sym[k];
    }
    return out;
}

function detectLanguage(filePath: string): string {
    if (/\.(ts|tsx)$/.test(filePath)) {
        return 'typescript';
    }
    return 'typescript';
}
