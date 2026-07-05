import * as path from 'path';
import { CallGraph, FunctionInfo, CallCanvasNestedOmission } from './types';

/**
 * Build one-line preview: signature through first `{` then `...` (plan: const x = (...) => {...).
 */
export function buildNestedLocalPreviewText(child: FunctionInfo): string {
    const text = child.code.replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    for (const raw of lines) {
        const ln = raw.trimEnd();
        if (!ln || ln.startsWith('//') || ln === '*/' || /^\*[^/]/.test(ln)) {
            continue;
        }
        const idx = ln.indexOf('{');
        if (idx >= 0) {
            return `${ln.slice(0, idx + 1)}...`;
        }
        return `${ln} {...`;
    }
    return `${child.functionName}() {...`;
}

/**
 * For each parent signature, list omissions (child snippet line range in file + preview).
 */
export function computeNestedOmissionsByParentSignature(callGraph: CallGraph): Map<string, CallCanvasNestedOmission[]> {
    const childrenByParent = new Map<string, FunctionInfo[]>();
    for (const [, info] of callGraph.functions) {
        if (!info.nestedUnder) {
            continue;
        }
        const list = childrenByParent.get(info.nestedUnder) ?? [];
        list.push(info);
        childrenByParent.set(info.nestedUnder, list);
    }

    const out = new Map<string, CallCanvasNestedOmission[]>();
    for (const [parentSig, children] of childrenByParent) {
        const parent = callGraph.functions.get(parentSig);
        if (!parent) {
            continue;
        }
        const parentPath = path.normalize(parent.absolutePath);
        const omissions: CallCanvasNestedOmission[] = [];
        for (const ch of children) {
            if (path.normalize(ch.absolutePath) !== parentPath) {
                continue;
            }
            omissions.push({
                startLine: ch.startLine,
                endLine: ch.endLine,
                previewText: buildNestedLocalPreviewText(ch),
            });
        }
        if (omissions.length > 0) {
            omissions.sort((a, b) => a.startLine - b.startLine);
            out.set(parentSig, omissions);
        }
    }
    return out;
}
