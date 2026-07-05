import * as path from 'path';
import { CallGraph, CallCanvasJSON, CallCanvasWindow, CallCanvasConnection, CallCanvasMetadata } from './types';

/**
 * Convert a CallGraph to CallCanvas JSON format compatible with callcanvas-viewer.
 */
export function formatAsCallCanvasJSON(
    callGraph: CallGraph,
    rootSignature: string,
    metadata?: CallCanvasMetadata,
    workspaceRoot?: string
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
    return result;
}

function detectLanguage(filePath: string): string {
    if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(filePath)) {
        return 'javascript';
    }
    return 'javascript';
}
