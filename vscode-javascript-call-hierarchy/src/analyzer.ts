import * as ts from 'typescript';
import * as path from 'path';
import { ProjectContext, FunctionInfo, CallInfo, CallGraph } from './types';
import { resolveFunctionAtLine, buildFunctionInfoFromSymbol } from './functionResolver';

type LogFn = (message: string) => void;

/**
 * Create a ts.Program from the project context.
 */
export function createProgram(context: ProjectContext): ts.Program {
    let options: ts.CompilerOptions;

    if (context.compilerOptions) {
        options = { ...context.compilerOptions, noEmit: true };
    } else {
        // Default options for vanilla JS (HTML-based or single file)
        options = {
            allowJs: true,
            checkJs: false,
            noEmit: true,
            target: ts.ScriptTarget.ESNext,
            // No module setting → script mode (global scope shared)
        };
    }

    return ts.createProgram(context.files, options);
}

/**
 * Analyze call hierarchy starting from a function at the given file and line.
 * Returns a CallGraph with all discovered functions and their call relationships.
 */
export function analyzeCallHierarchy(
    program: ts.Program,
    targetFilePath: string,
    targetLine: number,
    rootDir: string,
    maxDepth: number = 5,
    log: LogFn = () => {}
): CallGraph {
    const checker = program.getTypeChecker();
    const functions = new Map<string, FunctionInfo>();
    const calls: CallInfo[] = [];
    const visited = new Set<string>();

    // Find the target function
    const sourceFile = program.getSourceFile(path.resolve(targetFilePath));
    if (!sourceFile) {
        log(`Source file not found: ${targetFilePath}`);
        return { functions, calls };
    }

    const rootFunction = resolveFunctionAtLine(sourceFile, targetLine, rootDir);
    if (!rootFunction) {
        log(`No function found at ${targetFilePath}:${targetLine}`);
        return { functions, calls };
    }

    log(`Root function: ${rootFunction.displayName} (${rootFunction.signature})`);
    functions.set(rootFunction.signature, rootFunction);
    visited.add(rootFunction.signature);

    // BFS queue: [signature, currentDepth]
    const queue: [string, number][] = [[rootFunction.signature, 0]];

    while (queue.length > 0) {
        const [currentSig, depth] = queue.shift()!;
        if (depth >= maxDepth) {
            continue;
        }

        const currentFunc = functions.get(currentSig);
        if (!currentFunc) { continue; }

        log(`Analyzing: ${currentFunc.displayName} (depth=${depth})`);

        // Find the AST node for this function
        const funcSourceFile = program.getSourceFile(currentFunc.absolutePath);
        if (!funcSourceFile) { continue; }

        const funcNode = findFunctionNode(funcSourceFile, currentFunc.startLine);
        if (!funcNode) {
            log(`  Could not find function node for ${currentFunc.displayName}`);
            continue;
        }

        // Scan function body for call expressions
        const callsFound = findCallsInFunction(
            funcNode, funcSourceFile, checker, rootDir, currentSig, program, log
        );

        for (const { calleeInfo, callLine, callEndLine } of callsFound) {
            // Record call relationship
            calls.push({
                callerSignature: currentSig,
                calleeSignature: calleeInfo.signature,
                callLine,
                callEndLine,
            });

            // Add callee to functions map if new
            if (!functions.has(calleeInfo.signature)) {
                functions.set(calleeInfo.signature, calleeInfo);
            }

            // Add to BFS queue if not visited (skip self-recursion and already visited)
            if (!visited.has(calleeInfo.signature)) {
                visited.add(calleeInfo.signature);
                queue.push([calleeInfo.signature, depth + 1]);
            }
        }
    }

    return { functions, calls };
}

/**
 * Analyze call hierarchy starting from a known signature.
 * Used by the analyzeMethod API command.
 */
export function analyzeCallHierarchyBySignature(
    program: ts.Program,
    signature: string,
    rootDir: string,
    maxDepth: number = 1,
    log: LogFn = () => {}
): CallGraph {
    // Parse signature: filePath#[ClassName.]functionName:startLine
    const hashIndex = signature.indexOf('#');
    const colonIndex = signature.lastIndexOf(':');
    if (hashIndex === -1 || colonIndex === -1 || colonIndex <= hashIndex) {
        log(`Invalid signature format: ${signature}`);
        return { functions: new Map(), calls: [] };
    }

    const filePath = signature.substring(0, hashIndex);
    const startLine = parseInt(signature.substring(colonIndex + 1), 10);
    const absolutePath = path.resolve(rootDir, filePath);

    return analyzeCallHierarchy(program, absolutePath, startLine, rootDir, maxDepth, log);
}

interface CallFound {
    calleeInfo: FunctionInfo;
    callLine: number;
    callEndLine: number;
}

function findCallsInFunction(
    funcNode: ts.Node,
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    rootDir: string,
    callerSignature: string,
    program: ts.Program,
    log: LogFn
): CallFound[] {
    const results: CallFound[] = [];

    function visit(node: ts.Node): void {
        // Skip nested named function / method bodies — they are analyzed separately via BFS.
        // Arrow functions and anonymous function expressions stay (no separate window).
        if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
            return;
        }

        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const expression = node.expression;
            const callStart = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            const callEnd = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
            const callLine = callStart.line + 1;
            const callEndLine = callEnd.line + 1;

            let symbol: ts.Symbol | undefined;
            try {
                symbol = checker.getSymbolAtLocation(expression);
                // Follow aliases (imports)
                if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
                    symbol = checker.getAliasedSymbol(symbol);
                }
            } catch {
                // Symbol resolution failed - skip
            }

            if (symbol) {
                const declarations = symbol.getDeclarations();
                if (declarations && declarations.length > 0) {
                    const decl = declarations[0];
                    const declSourceFile = decl.getSourceFile();
                    const declFilePath = declSourceFile.fileName;

                    // Only include project-internal files (not node_modules, not .d.ts)
                    if (!declFilePath.includes('node_modules') &&
                        !declFilePath.endsWith('.d.ts')) {
                        const calleeInfo = buildFunctionInfoFromSymbol(
                            symbol, decl, declSourceFile, rootDir
                        );
                        if (calleeInfo) {
                            results.push({ calleeInfo, callLine, callEndLine });
                        }
                    }
                }
            } else {
                const callText = expression.getText(sourceFile);
                // Don't log common built-in calls
                if (!callText.startsWith('console.') && callText !== 'require') {
                    log(`  Unresolved call: ${callText} at line ${callLine}`);
                }
            }

            // Detect callback function references passed as arguments.
            // Handles direct refs: setTimeout(doSomething, 1000)
            // and object literal props: doRequest({ success: onSuccess, error: onError })
            if (ts.isCallExpression(node)) {
                const tryResolveCallbackRef = (expr: ts.Expression, positionNode?: ts.Node): void => {
                    if (!ts.isIdentifier(expr) && !ts.isPropertyAccessExpression(expr)) {
                        return;
                    }
                    let argSymbol: ts.Symbol | undefined;
                    try {
                        argSymbol = checker.getSymbolAtLocation(expr);
                        if (argSymbol && (argSymbol.flags & ts.SymbolFlags.Alias)) {
                            argSymbol = checker.getAliasedSymbol(argSymbol);
                        }
                    } catch {
                        return;
                    }
                    if (!argSymbol) { return; }

                    let isFunctionType = false;
                    try {
                        const argType = checker.getTypeAtLocation(expr);
                        isFunctionType = argType.getCallSignatures().length > 0;
                    } catch {
                        return;
                    }
                    if (!isFunctionType) { return; }

                    const argDeclarations = argSymbol.getDeclarations();
                    if (!argDeclarations || argDeclarations.length === 0) { return; }

                    const argDecl = argDeclarations[0];
                    const argSourceFile = argDecl.getSourceFile();
                    const argFilePath = argSourceFile.fileName;

                    if (argFilePath.includes('node_modules') || argFilePath.endsWith('.d.ts')) {
                        return;
                    }

                    const calleeInfo = buildFunctionInfoFromSymbol(
                        argSymbol, argDecl, argSourceFile, rootDir
                    );
                    if (calleeInfo) {
                        const lineNode = positionNode ?? node;
                        const refStart = sourceFile.getLineAndCharacterOfPosition(lineNode.getStart(sourceFile));
                        const refEnd = sourceFile.getLineAndCharacterOfPosition(lineNode.getEnd());
                        const refLine = refStart.line + 1;
                        const refEndLine = refEnd.line + 1;
                        log(`  Callback reference: ${calleeInfo.functionName} at line ${refLine}`);
                        results.push({ calleeInfo, callLine: refLine, callEndLine: refEndLine });
                    }
                };

                // Helper: scan object literal properties for callback references.
                // Handles both named assignment ({ callback: fn }) and shorthand ({ fn }).
                // Uses the line of each callback reference so F12 in the viewer jumps to the correct line.
                const scanObjectLiteralForCallbacks = (objLit: ts.ObjectLiteralExpression): void => {
                    for (const prop of objLit.properties) {
                        if (ts.isPropertyAssignment(prop)) {
                            tryResolveCallbackRef(prop.initializer, prop.initializer);
                        } else if (ts.isShorthandPropertyAssignment(prop)) {
                            // For { foo }, getSymbolAtLocation(prop.name) returns the property
                            // symbol whose declaration points back to this shorthand node.
                            // We must use getShorthandAssignmentValueSymbol to get the actual
                            // outer-scope function symbol and its correct declaration position.
                            let valueSymbol: ts.Symbol | undefined;
                            try {
                                valueSymbol = checker.getShorthandAssignmentValueSymbol(prop);
                                if (valueSymbol && (valueSymbol.flags & ts.SymbolFlags.Alias)) {
                                    valueSymbol = checker.getAliasedSymbol(valueSymbol);
                                }
                            } catch {
                                continue;
                            }
                            if (!valueSymbol) { continue; }
                            let isFunctionType = false;
                            try {
                                isFunctionType = checker.getTypeAtLocation(prop.name).getCallSignatures().length > 0;
                            } catch {
                                continue;
                            }
                            if (!isFunctionType) { continue; }
                            const decls = valueSymbol.getDeclarations();
                            if (!decls || decls.length === 0) { continue; }
                            const decl = decls[0];
                            const declSF = decl.getSourceFile();
                            if (declSF.fileName.includes('node_modules') || declSF.fileName.endsWith('.d.ts')) {
                                continue;
                            }
                            const calleeInfo = buildFunctionInfoFromSymbol(valueSymbol, decl, declSF, rootDir);
                            if (calleeInfo) {
                                const refStart = sourceFile.getLineAndCharacterOfPosition(prop.name.getStart(sourceFile));
                                const refEnd = sourceFile.getLineAndCharacterOfPosition(prop.name.getEnd());
                                const refLine = refStart.line + 1;
                                const refEndLine = refEnd.line + 1;
                                log(`  Shorthand callback reference: ${calleeInfo.functionName} at line ${refLine}`);
                                results.push({ calleeInfo, callLine: refLine, callEndLine: refEndLine });
                            }
                        }
                    }
                };

                for (const arg of node.arguments) {
                    if (ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg)) {
                        // Direct function reference: func(handleClick)
                        tryResolveCallbackRef(arg);

                        // Variable → ObjectLiteral resolution:
                        // const opts = { callback: handleFunc }; func(opts);
                        if (ts.isIdentifier(arg)) {
                            let argSymbol: ts.Symbol | undefined;
                            try {
                                argSymbol = checker.getSymbolAtLocation(arg);
                                if (argSymbol && (argSymbol.flags & ts.SymbolFlags.Alias)) {
                                    argSymbol = checker.getAliasedSymbol(argSymbol);
                                }
                            } catch {
                                argSymbol = undefined;
                            }
                            if (argSymbol) {
                                const argDecls = argSymbol.getDeclarations();
                                if (argDecls && argDecls.length > 0) {
                                    const argDecl = argDecls[0];
                                    if (ts.isVariableDeclaration(argDecl) &&
                                        argDecl.initializer &&
                                        ts.isObjectLiteralExpression(argDecl.initializer)) {
                                        scanObjectLiteralForCallbacks(argDecl.initializer);
                                    }
                                }
                            }
                        }
                    } else if (ts.isObjectLiteralExpression(arg)) {
                        // Inline object literal with function-valued properties:
                        // func({ success: onSuccess, error: onError })
                        scanObjectLiteralForCallbacks(arg);
                    }
                }
            }
        }

        // Also check tagged template expressions
        if (ts.isTaggedTemplateExpression(node)) {
            const tag = node.tag;
            const callStart = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            const callEnd = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
            const callLine = callStart.line + 1;
            const callEndLine = callEnd.line + 1;

            let symbol: ts.Symbol | undefined;
            try {
                symbol = checker.getSymbolAtLocation(tag);
            } catch {
                // Skip
            }

            if (symbol) {
                const declarations = symbol.getDeclarations();
                if (declarations && declarations.length > 0) {
                    const decl = declarations[0];
                    const declSourceFile = decl.getSourceFile();
                    const declFilePath = declSourceFile.fileName;
                    if (!declFilePath.includes('node_modules') && !declFilePath.endsWith('.d.ts')) {
                        const calleeInfo = buildFunctionInfoFromSymbol(
                            symbol, decl, declSourceFile, rootDir
                        );
                        if (calleeInfo) {
                            results.push({ calleeInfo, callLine, callEndLine });
                        }
                    }
                }
            }
        }

        ts.forEachChild(node, visit);
    }

    // Visit the function body (not the function itself to avoid re-detecting the function declaration)
    const body = getFunctionBody(funcNode);
    if (body) {
        ts.forEachChild(body, visit);
    } else {
        ts.forEachChild(funcNode, visit);
    }

    return results;
}

function findFunctionNode(sourceFile: ts.SourceFile, line: number): ts.Node | null {
    let bestMatch: ts.Node | null = null;
    let bestSize = Infinity;

    function visit(node: ts.Node): void {
        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
        const nodeStartLine = start.line + 1;
        const nodeEndLine = end.line + 1;

        if (nodeStartLine <= line && line <= nodeEndLine) {
            if (isFunctionLike(node)) {
                const size = nodeEndLine - nodeStartLine;
                if (size < bestSize) {
                    bestSize = size;
                    bestMatch = node;
                }
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return bestMatch;
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

function getFunctionBody(node: ts.Node): ts.Node | null {
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
