import * as ts from 'typescript';
import * as path from 'path';
import { FunctionInfo } from './types';

/**
 * Resolve the function signature at each line of a file of the program
 * (the resolveMethodSignature / resolveMethodSignatures APIs).
 * The program is bound first, as analyzeCallHierarchy does: resolveFunctionAtLine reads
 * node.parent (callbacks, function expressions), which only binding sets.
 * Returns null when the file is not in the program.
 */
export function resolveSignaturesAtLines(
    program: ts.Program,
    absolutePath: string,
    lines: number[],
    rootDir: string
): (string | null)[] | null {
    program.getTypeChecker();
    const sourceFile = program.getSourceFile(absolutePath);
    if (!sourceFile) {
        return null;
    }
    return lines.map(line => resolveFunctionAtLine(sourceFile, line, rootDir)?.signature ?? null);
}

/**
 * Find the function at the given line in a source file.
 * Returns FunctionInfo for the innermost function containing the line.
 */
export function resolveFunctionAtLine(
    sourceFile: ts.SourceFile,
    line: number,
    rootDir: string
): FunctionInfo | null {
    const targetLine = line; // 1-based
    let bestMatch: { node: ts.Node; startLine: number; endLine: number; className?: string } | null = null;

    function visit(node: ts.Node): void {
        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
        const nodeStartLine = start.line + 1; // to 1-based
        const nodeEndLine = end.line + 1;

        if (nodeStartLine <= targetLine && targetLine <= nodeEndLine) {
            if (isFunctionLike(node)) {
                // Check if this is a class method
                const className = getClassName(node);
                if (!bestMatch || (nodeEndLine - nodeStartLine) < (bestMatch.endLine - bestMatch.startLine)) {
                    bestMatch = { node, startLine: nodeStartLine, endLine: nodeEndLine, className };
                }
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    if (!bestMatch) {
        return null;
    }

    const result = bestMatch as { node: ts.Node; startLine: number; endLine: number; className?: string };
    const matchedNode = result.node;
    const className = result.className;
    const functionName = getFunctionName(matchedNode, sourceFile);
    if (!functionName) {
        return null;
    }

    const absolutePath = sourceFile.fileName;
    const filePath = path.relative(rootDir, absolutePath);
    const fileBaseName = path.basename(absolutePath, path.extname(absolutePath));

    const displayName = className
        ? `${className} # ${functionName}`
        : `${fileBaseName} # ${functionName}`;

    const signatureName = className
        ? `${className}.${functionName}`
        : functionName;

    const declarationLine = result.startLine;
    const signature = `${filePath}#${signatureName}:${declarationLine}`;

    const snippetNode = findEnclosingStatement(matchedNode);
    const codeStartPos = callcanvasSnippetStartPos(snippetNode, sourceFile);
    const codeEndPos = snippetNode.getEnd();
    const code = sourceFile.text.substring(codeStartPos, codeEndPos);
    const displayStart = sourceFile.getLineAndCharacterOfPosition(codeStartPos);
    const displayEnd = sourceFile.getLineAndCharacterOfPosition(codeEndPos);
    const displayStartLine = displayStart.line + 1;
    const displayEndLine = Math.max(displayStartLine, displayEnd.line + 1);

    return {
        signature,
        displayName,
        filePath,
        absolutePath,
        functionName,
        className,
        declarationLine,
        startLine: displayStartLine,
        endLine: displayEndLine,
        code,
    };
}

/**
 * Build a FunctionInfo from a ts.Symbol's declaration.
 */
export function buildFunctionInfoFromSymbol(
    symbol: ts.Symbol,
    declaration: ts.Node,
    sourceFile: ts.SourceFile,
    rootDir: string
): FunctionInfo | null {
    // Skip parameter declarations — a parameter like `fn` in `function foo(fn)`
    // is not a function definition.  The actual callback is already detected at
    // the call-site by the callback-reference logic in the analyzer.
    if (declaration && ts.isParameter(declaration)) {
        return null;
    }

    // Destructured locals (hooks, etc.) and `const` without a direct function initializer are not
    // analyzable call roots: `findFunctionNode(declarationLine)` resolves the enclosing function and
    // duplicates all its outgoing calls under this symbol.
    if (declaration && ts.isBindingElement(declaration)) {
        return null;
    }
    if (declaration && ts.isVariableDeclaration(declaration)) {
        const init = declaration.initializer;
        if (!init || (!ts.isFunctionExpression(init) && !ts.isArrowFunction(init))) {
            return null;
        }
    }

    const functionName = symbol.getName();
    if (!functionName || functionName === '__function') {
        return null;
    }

    const className = getClassName(declaration);
    const absolutePath = sourceFile.fileName;
    const filePath = path.relative(rootDir, absolutePath);
    const fileBaseName = path.basename(absolutePath, path.extname(absolutePath));

    const displayName = className
        ? `${className} # ${functionName}`
        : `${fileBaseName} # ${functionName}`;

    const signatureName = className
        ? `${className}.${functionName}`
        : functionName;

    const codeNode = findEnclosingStatement(declaration);

    const declPos = codeNode.getStart(sourceFile);
    const declarationLine = sourceFile.getLineAndCharacterOfPosition(declPos).line + 1;
    const signature = `${filePath}#${signatureName}:${declarationLine}`;

    const codeStartPos = callcanvasSnippetStartPos(codeNode, sourceFile);
    const codeEndPos = codeNode.getEnd();
    const code = sourceFile.text.substring(codeStartPos, codeEndPos);
    const displayStart = sourceFile.getLineAndCharacterOfPosition(codeStartPos);
    const lastCharPos = codeEndPos > codeStartPos ? codeEndPos - 1 : codeStartPos;
    const displayEnd = sourceFile.getLineAndCharacterOfPosition(lastCharPos);
    const startLine = displayStart.line + 1;
    const endLine = Math.max(startLine, displayEnd.line + 1);

    return {
        signature,
        displayName,
        filePath,
        absolutePath,
        functionName,
        className,
        declarationLine,
        startLine,
        endLine,
        code,
    };
}

/**
 * Walk up from `node` to the nearest statement-level ancestor — a direct child of a block-like
 * container (SourceFile, Block, ModuleBlock, CaseClause) or a class/interface body.
 *
 * This ensures CallCanvas snippets include `const`/`export` keywords and leading JSDoc regardless
 * of which inner AST node (`VariableDeclaration`, `ArrowFunction`, etc.) was resolved.
 */
export function findEnclosingStatement(node: ts.Node): ts.Node {
    let current = node;
    while (current.parent) {
        const parent = current.parent;
        if (
            ts.isSourceFile(parent) ||
            ts.isBlock(parent) ||
            ts.isModuleBlock(parent) ||
            ts.isCaseClause(parent) ||
            ts.isClassDeclaration(parent) ||
            ts.isClassExpression(parent) ||
            ts.isInterfaceDeclaration(parent)
        ) {
            return current;
        }
        current = parent;
    }
    return node;
}

/**
 * Start offset for CallCanvas `code`: first leading line/block comment if any, else first declaration token.
 * Avoids `getFullStart()` including blank lines after the previous statement (e.g. after imports).
 */
export function callcanvasSnippetStartPos(codeNode: ts.Node, sourceFile: ts.SourceFile): number {
    const text = sourceFile.text;
    const ranges = ts.getLeadingCommentRanges(text, codeNode.pos);
    if (ranges && ranges.length > 0) {
        return Math.min(...ranges.map((r) => r.pos));
    }
    return codeNode.getStart(sourceFile);
}

function isFunctionLike(node: ts.Node): boolean {
    return (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
    );
}

export function getFunctionName(node: ts.Node, sourceFile: ts.SourceFile): string | null {
    // Function declaration: function foo() {}
    if (ts.isFunctionDeclaration(node)) {
        return node.name?.text ?? null;
    }

    // Method declaration: class Foo { bar() {} }
    if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
        if (ts.isIdentifier(node.name)) {
            return node.name.text;
        }
        return node.name.getText(sourceFile);
    }

    // Constructor
    if (ts.isConstructorDeclaration(node)) {
        return 'constructor';
    }

    // Variable assignment: const foo = function() {} or const foo = () => {}
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
        const parent = node.parent;
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
            return parent.name.text;
        }
        // Property assignment: { foo: function() {} } or { foo() {} }
        if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
            return parent.name.text;
        }
        // Prototype assignment: Foo.prototype.bar = function() {}
        if (ts.isBinaryExpression(parent) && ts.isPropertyAccessExpression(parent.left)) {
            const propAccess = parent.left;
            if (ts.isPropertyAccessExpression(propAccess.expression)) {
                const innerProp = propAccess.expression;
                if (ts.isIdentifier(innerProp.name) && innerProp.name.text === 'prototype') {
                    return propAccess.name.text;
                }
            }
        }
        // Named function expression: const x = function foo() {}
        if (ts.isFunctionExpression(node) && node.name) {
            return node.name.text;
        }
        // IIFE: (function(){})()
        if (ts.isParenthesizedExpression(parent) && ts.isCallExpression(parent.parent)) {
            return 'IIFE';
        }
        // Callback argument: $(function(){}), setTimeout(function(){}, 100), app.get('/path', function(){})
        if (ts.isCallExpression(parent)) {
            const calleeName = getCallExpressionLeafName(parent.expression);
            if (calleeName) {
                return `${calleeName}_callback`;
            }
            return 'callback';
        }
    }

    return null;
}

/**
 * Extract the "leaf" name from a call expression's callee expression.
 * - foo(...)         → "foo"
 * - obj.method(...)  → "method"
 * - $(...)           → "$"
 */
export function getCallExpressionLeafName(expr: ts.Expression): string | null {
    if (ts.isIdentifier(expr)) {
        return expr.text;
    }
    if (ts.isPropertyAccessExpression(expr)) {
        return expr.name.text;
    }
    return null;
}

function getClassName(node: ts.Node): string | undefined {
    // Direct class method
    if (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
        const parent = node.parent;
        if (ts.isClassDeclaration(parent) && parent.name) {
            return parent.name.text;
        }
        if (ts.isClassExpression(parent) && parent.name) {
            return parent.name.text;
        }
    }

    // Prototype assignment: Foo.prototype.bar = function() {}
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
        const parent = node.parent;
        if (ts.isBinaryExpression(parent) && ts.isPropertyAccessExpression(parent.left)) {
            const propAccess = parent.left;
            if (ts.isPropertyAccessExpression(propAccess.expression)) {
                const innerProp = propAccess.expression;
                if (ts.isIdentifier(innerProp.name) && innerProp.name.text === 'prototype' &&
                    ts.isIdentifier(innerProp.expression)) {
                    return innerProp.expression.text;
                }
            }
        }
    }

    return undefined;
}

