import * as path from 'path';
import * as fs from 'fs';
import { IncludeEdge } from './templateIncludeResolver';
import { CallCanvasJSON, CallCanvasWindow, CallCanvasConnection } from './types';

/**
 * Convert an include tree (nodes + edges) to CallCanvas JSON format.
 * Each node (template file) becomes a CallCanvasWindow with its full content.
 * Each edge (include directive) becomes a CallCanvasConnection.
 */
export function formatIncludeMapAsCallCanvasJSON(
    nodes: string[],
    edges: IncludeEdge[],
    workspaceRoot?: string
): CallCanvasJSON {
    const windows: CallCanvasWindow[] = [];
    const connections: CallCanvasConnection[] = [];
    const fileToWindowId = new Map<string, string>();

    for (let i = 0; i < nodes.length; i++) {
        const filePath = nodes[i];
        const windowId = `window-${i + 1}`;
        fileToWindowId.set(path.normalize(filePath), windowId);

        const displayName = workspaceRoot
            ? path.relative(workspaceRoot, filePath)
            : path.basename(filePath);

        let content = '';
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch {
            content = '';
        }

        const lines = content.split('\n');

        windows.push({
            id: windowId,
            displayName,
            filePath: workspaceRoot
                ? path.relative(workspaceRoot, filePath)
                : filePath,
            language: detectLanguage(filePath),
            code: content,
            startLine: 1,
            endLine: lines.length,
        });
    }

    let connectionIndex = 0;
    for (const edge of edges) {
        const fromId = fileToWindowId.get(path.normalize(edge.fromFile));
        const toId = fileToWindowId.get(path.normalize(edge.toFile));
        if (fromId && toId) {
            connectionIndex++;
            connections.push({
                id: `connection-${connectionIndex}`,
                from: fromId,
                to: toId,
                callLine: edge.directiveLine,
                callEndLine: edge.directiveLine,
            });
        }
    }

    return {
        autoLayout: true,
        windows,
        connections,
    };
}

function detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.ftl' || ext === '.ftlh') { return 'freemarker'; }
    if (ext === '.jsp' || ext === '.jspf') { return 'jsp'; }
    return 'html';
}
