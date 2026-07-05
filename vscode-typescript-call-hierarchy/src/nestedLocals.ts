import * as ts from 'typescript';
import * as path from 'path';
import { FunctionInfo } from './types';
import {
    findEnclosingStatement,
    callcanvasSnippetStartPos,
    getFunctionName,
    buildFunctionInfoFromSymbol,
    getCallExpressionLeafName,
} from './functionResolver';

/** Only split inline `useEffect(() => …)`-style args; keep generic `fn(() => …)` as part of the parent window. */
const HOOK_STYLE_CALLEE_NAMES = new Set([
    'useEffect',
    'useLayoutEffect',
    'useMemo',
    'useCallback',
    'useInsertionEffect',
    'useImperativeHandle',
    'useReducer',
]);

/** Root AST node for a nested local function under an enclosing function-like node. */
export interface NestedLocalRoot {
    rootNode: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;
    localName: string;
    connectionLine: number;
    connectionEndLine: number;
    /** For `const x = () =>` — used to map symbol-based callee signatures to the nested window. */
    variableDeclaration?: ts.VariableDeclaration;
}

/**
 * Middle segment of a signature: `filePath#THIS:line` (class.method or function name).
 */
export function signatureNamePath(signature: string): string {
    const hashIndex = signature.indexOf('#');
    const colonIndex = signature.lastIndexOf(':');
    if (hashIndex === -1 || colonIndex === -1 || colonIndex <= hashIndex) {
        return '';
    }
    return signature.substring(hashIndex + 1, colonIndex);
}

function getFunctionBodyNode(node: ts.Node): ts.Node | null {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
        return node.body ?? null;
    }
    if (ts.isArrowFunction(node)) {
        return node.body;
    }
    return null;
}

/** Text range of the inner executable part of a function-like node (body subtree). */
function innerBodyRange(root: ts.Node): { pos: number; end: number } | null {
    if (ts.isFunctionDeclaration(root) || ts.isFunctionExpression(root)) {
        if (!root.body) { return null; }
        return { pos: root.body.getFullStart(), end: root.end };
    }
    if (ts.isArrowFunction(root)) {
        return { pos: root.body.pos, end: root.end };
    }
    return null;
}

function containsInnerBody(outerRoot: ts.Node, innerRoot: ts.Node, sourceFile: ts.SourceFile): boolean {
    if (outerRoot === innerRoot) { return false; }
    const br = innerBodyRange(outerRoot);
    if (!br) { return false; }
    const innerStart = innerRoot.getStart(sourceFile);
    const innerEnd = innerRoot.getEnd();
    return innerStart >= br.pos && innerEnd <= br.end;
}

/**
 * Collect nested local function roots directly under `parentFuncNode`'s body that are not
 * contained in any other candidate's body (e.g. `useEffect` callback vs handlers inside it).
 */
export function collectImmediateNestedRoots(
    parentFuncNode: ts.Node,
    sourceFile: ts.SourceFile
): NestedLocalRoot[] {
    const body = getFunctionBodyNode(parentFuncNode);
    if (!body) { return []; }

    const candidates: NestedLocalRoot[] = [];

    function considerCandidate(
        rootNode: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
        localName: string,
        variableDeclaration?: ts.VariableDeclaration
    ): void {
        const start = sourceFile.getLineAndCharacterOfPosition(rootNode.getStart(sourceFile));
        const end = sourceFile.getLineAndCharacterOfPosition(rootNode.getEnd());
        const connectionLine = variableDeclaration
            ? sourceFile.getLineAndCharacterOfPosition(variableDeclaration.getStart(sourceFile)).line + 1
            : start.line + 1;
        const connectionEndLine = variableDeclaration
            ? sourceFile.getLineAndCharacterOfPosition(variableDeclaration.getEnd()).line + 1
            : end.line + 1;
        candidates.push({
            rootNode,
            localName,
            connectionLine,
            connectionEndLine,
            variableDeclaration,
        });
    }

    function walk(n: ts.Node): void {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
            if (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) {
                considerCandidate(n.initializer, n.name.text, n);
            }
        }

        if (ts.isFunctionDeclaration(n) && n.name && !ts.isSourceFile(n.parent)) {
            considerCandidate(n, n.name.text);
        }

        if (ts.isCallExpression(n)) {
            const calleeLeaf = getCallExpressionLeafName(n.expression);
            const allowInlineCallbackSplit =
                calleeLeaf !== null && HOOK_STYLE_CALLEE_NAMES.has(calleeLeaf);
            if (allowInlineCallbackSplit) {
                for (const arg of n.arguments) {
                    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
                        const fnm = getFunctionName(arg, sourceFile);
                        if (fnm) {
                            considerCandidate(arg, fnm);
                        }
                    }
                }
            }
        }

        ts.forEachChild(n, walk);
    }

    walk(body);

    const filtered = candidates.filter((c) =>
        !candidates.some((o) => o !== c && containsInnerBody(o.rootNode, c.rootNode, sourceFile))
    );

    const dedupe = new Map<string, NestedLocalRoot>();
    for (const c of filtered) {
        const key = `${c.localName}:${c.rootNode.pos}`;
        dedupe.set(key, c);
    }
    return [...dedupe.values()];
}

/**
 * Build {@link FunctionInfo} for a nested local, with a signature compatible with
 * `findFunctionNode(sourceFile, declarationLine)` (anchor on the function root token).
 */
export function buildNestedLocalFunctionInfo(
    parent: FunctionInfo,
    root: NestedLocalRoot,
    sourceFile: ts.SourceFile,
    rootDir: string
): FunctionInfo {
    const { rootNode, localName } = root;
    const absolutePath = sourceFile.fileName;
    const filePath = path.relative(rootDir, absolutePath);
    const fileBaseName = path.basename(absolutePath, path.extname(absolutePath));
    const parentPath = signatureNamePath(parent.signature);
    const sigName = `${parentPath}>${localName}`;

    const declPos = rootNode.getStart(sourceFile);
    const declarationLine = sourceFile.getLineAndCharacterOfPosition(declPos).line + 1;
    const signature = `${filePath}#${sigName}:${declarationLine}`;

    const anchorForStatement = ts.isFunctionDeclaration(rootNode)
        ? rootNode
        : (root.variableDeclaration ? findEnclosingStatement(root.variableDeclaration) : findEnclosingStatement(rootNode));
    const codeNode = anchorForStatement;
    const codeStartPos = callcanvasSnippetStartPos(codeNode, sourceFile);
    const codeEndPos = codeNode.getEnd();
    const code = sourceFile.text.substring(codeStartPos, codeEndPos);
    const displayStart = sourceFile.getLineAndCharacterOfPosition(codeStartPos);
    // getEnd() is the first position *after* the node; that often sits on the next line (after \n),
    // which inflated endLine and broke single-line detection (e.g. skip split for `const update = () => …`).
    const lastCharPos = codeEndPos > codeStartPos ? codeEndPos - 1 : codeStartPos;
    const displayEnd = sourceFile.getLineAndCharacterOfPosition(lastCharPos);
    const startLine = displayStart.line + 1;
    const endLine = Math.max(startLine, displayEnd.line + 1);

    const displayName = `${fileBaseName} # ${parentPath}.${localName}`;

    return {
        signature,
        displayName,
        filePath,
        absolutePath,
        functionName: localName,
        declarationLine,
        startLine,
        endLine,
        code,
        nestedUnder: parent.signature,
    };
}

/**
 * If `root` came from `const x = () =>`, map the symbol-based signature from
 * {@link buildFunctionInfoFromSymbol} to the nested {@link FunctionInfo}.
 */
export function tryNestedAliasForVariableRoot(
    checker: ts.TypeChecker,
    root: NestedLocalRoot,
    nestedInfo: FunctionInfo,
    sourceFile: ts.SourceFile,
    rootDir: string
): Map<string, FunctionInfo> {
    const out = new Map<string, FunctionInfo>();
    if (!root.variableDeclaration || !ts.isIdentifier(root.variableDeclaration.name)) {
        return out;
    }
    try {
        let sym = checker.getSymbolAtLocation(root.variableDeclaration.name);
        if (sym && (sym.flags & ts.SymbolFlags.Alias)) {
            sym = checker.getAliasedSymbol(sym);
        }
        if (!sym) { return out; }
        const alt = buildFunctionInfoFromSymbol(sym, root.variableDeclaration, sourceFile, rootDir);
        if (alt) {
            out.set(alt.signature, nestedInfo);
        }
    } catch {
        /* ignore */
    }

    if (ts.isFunctionDeclaration(root.rootNode) && root.rootNode.name) {
        try {
            let sym = checker.getSymbolAtLocation(root.rootNode.name);
            if (sym && (sym.flags & ts.SymbolFlags.Alias)) {
                sym = checker.getAliasedSymbol(sym);
            }
            if (!sym) { return out; }
            const alt = buildFunctionInfoFromSymbol(sym, root.rootNode, sourceFile, rootDir);
            if (alt) {
                out.set(alt.signature, nestedInfo);
            }
        } catch {
            /* ignore */
        }
    }

    return out;
}
