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
    const startLine = result.startLine;
    const endLine = result.endLine;
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

    const signature = `${filePath}#${signatureName}:${startLine}`;

    const code = sourceFile.text.substring(
        sourceFile.getLineAndCharacterOfPosition(matchedNode.getStart(sourceFile)).line === 0
            ? matchedNode.getStart(sourceFile)
            : sourceFile.getPositionOfLineAndCharacter(startLine - 1, 0),
        matchedNode.getEnd()
    );

    return {
        signature,
        displayName,
        filePath,
        absolutePath,
        functionName,
        className,
        startLine,
        endLine,
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
    const start = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile));
    const end = sourceFile.getLineAndCharacterOfPosition(declaration.getEnd());
    const startLine = start.line + 1;
    const endLine = end.line + 1;

    // Skip parameter declarations — a parameter like `fn` in `function foo(fn)`
    // is not a function definition.  The actual callback is already detected at
    // the call-site by the callback-reference logic in the analyzer.
    if (declaration && ts.isParameter(declaration)) {
        return null;
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

    const signature = `${filePath}#${signatureName}:${startLine}`;

    // Extract code - get the containing function declaration
    const funcNode = getFunctionContainer(declaration);
    const codeNode = funcNode || declaration;
    const codeStart = sourceFile.getPositionOfLineAndCharacter(
        sourceFile.getLineAndCharacterOfPosition(codeNode.getStart(sourceFile)).line, 0
    );
    const code = sourceFile.text.substring(codeStart, codeNode.getEnd());

    return {
        signature,
        displayName,
        filePath,
        absolutePath,
        functionName,
        className,
        startLine,
        endLine,
        code,
    };
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

function getFunctionName(node: ts.Node, sourceFile: ts.SourceFile): string | null {
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
function getCallExpressionLeafName(expr: ts.Expression): string | null {
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

function getFunctionContainer(node: ts.Node): ts.Node | null {
    let current: ts.Node | undefined = node;
    while (current) {
        if (isFunctionLike(current)) {
            // Check if there's a parent variable declaration
            if ((ts.isFunctionExpression(current) || ts.isArrowFunction(current)) &&
                ts.isVariableDeclaration(current.parent)) {
                // Go up to the variable statement
                if (ts.isVariableDeclarationList(current.parent.parent) &&
                    ts.isVariableStatement(current.parent.parent.parent)) {
                    return current.parent.parent.parent;
                }
                return current.parent;
            }
            return current;
        }
        current = current.parent;
    }
    return null;
}
