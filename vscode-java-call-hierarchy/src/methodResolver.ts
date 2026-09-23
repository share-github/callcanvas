import * as vscode from 'vscode';

/**
 * Resolves the method signature at the current cursor position.
 * Returns a string in the format: "com.example.ClassName#methodName(java.lang.String,int)"
 * with fully qualified names for both class and parameter types.
 */
export async function resolveMethodAtCursor(
    editor: vscode.TextEditor
): Promise<string | null> {
    const document = editor.document;
    const position = editor.selection.active;

    // Try to find method definition at or near the cursor
    const methodInfo = findMethodAtPosition(document, position);
    if (!methodInfo) {
        return null;
    }

    // Find the enclosing class name (simple name)
    const simpleClassName = findEnclosingClassName(document, position);
    if (!simpleClassName) {
        return null;
    }

    // Get the package name from the file
    const packageName = findPackageName(document);
    
    // Build fully qualified class name
    const className = packageName ? `${packageName}.${simpleClassName}` : simpleClassName;

    // Get import statements for resolving parameter types
    const imports = parseImports(document);
    
    // Resolve parameter types to fully qualified names
    const resolvedParams = methodInfo.params.map(param => resolveTypeName(param, packageName, imports));

    return `${className}#${methodInfo.name}(${resolvedParams.join(',')})`;
}

interface MethodInfo {
    name: string;
    params: string[];
    lineNumber: number;
}

/**
 * Find method definition at or near the given position.
 * Searches the current line first, then nearby lines for a method signature.
 * Prioritizes current line and searches outward.
 */
function findMethodAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
): MethodInfo | null {
    // First, try the current line (highest priority)
    const currentLineResult = parseMethodFromLine(document, position.line);
    if (currentLineResult) {
        return currentLineResult;
    }

    // Skip the documentation / annotation block that precedes a declaration and
    // test the first real line below it. CallCanvas windows start at the Javadoc
    // (OutputGenerator#findCommentStartLine) and JavaParser reports annotations as
    // part of the declaration, so the declaration is often far below the line we
    // were handed — a fixed 3-line lookahead missed it and the caller fell back to
    // a regex guess (or to no signature at all).
    const declLine = skipDocAndAnnotationBlock(document, position.line);
    if (declLine !== position.line) {
        const blockResult = parseMethodFromLine(document, declLine);
        if (blockResult) {
            return blockResult;
        }
    }

    // Search outward from current position, prioritizing closer lines
    // Search downward first (method body is usually below the signature)
    for (let offset = 1; offset <= 3; offset++) {
        const downLine = position.line + offset;
        if (downLine < document.lineCount) {
            const result = parseMethodFromLine(document, downLine);
            if (result) {
                return result;
            }
        }
    }

    // Then search upward (but only a few lines to avoid finding wrong method)
    for (let offset = 1; offset <= 2; offset++) {
        const upLine = position.line - offset;
        if (upLine >= 0) {
            const result = parseMethodFromLine(document, upLine);
            if (result) {
                return result;
            }
        }
    }

    return null;
}

/**
 * From `startLine`, skip blank lines, comment blocks and annotations (including
 * multi-line annotation argument lists) and return the first line that can hold
 * a declaration. Returns `startLine` itself when that line is already code.
 */
function skipDocAndAnnotationBlock(document: vscode.TextDocument, startLine: number): number {
    const MAX_BLOCK_LINES = 80;
    let line = startLine;
    let inBlockComment = false;
    let annotationDepth = 0;
    const limit = Math.min(document.lineCount - 1, startLine + MAX_BLOCK_LINES);

    while (line <= limit) {
        const text = document.lineAt(line).text.trim();

        if (inBlockComment) {
            if (text.includes('*/')) {
                inBlockComment = false;
                const after = text.substring(text.lastIndexOf('*/') + 2).trim();
                if (after.length > 0 && after.charAt(0) !== '@') {
                    return line;
                }
            }
            line++;
            continue;
        }

        if (annotationDepth > 0) {
            annotationDepth += countParenDelta(text);
            line++;
            continue;
        }

        if (text.length === 0 || text.startsWith('//')) {
            line++;
            continue;
        }
        if (text.startsWith('/*')) {
            if (!text.includes('*/')) {
                inBlockComment = true;
            }
            line++;
            continue;
        }
        if (text.startsWith('@')) {
            const delta = countParenDelta(text);
            annotationDepth = delta > 0 ? delta : 0;
            line++;
            continue;
        }
        return line;
    }
    return startLine;
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
 * Parse a method signature from a single line or multi-line context.
 */
function parseMethodFromLine(
    document: vscode.TextDocument,
    lineNumber: number
): MethodInfo | null {
    // Check if current line looks like it might contain a method start
    const currentLineText = document.lineAt(lineNumber).text;
    
    // Quick check: does this line contain common method modifiers or look like a method?
    if (!looksLikeMethodStart(currentLineText)) {
        return null;
    }

    // Read lines until we find a closing parenthesis or hit reasonable limit
    // Multi-line method signatures can span 10+ lines with many parameters
    let text = '';
    let foundOpenParen = false;
    let parenDepth = 0;
    
    for (let i = lineNumber; i <= Math.min(document.lineCount - 1, lineNumber + 15); i++) {
        const lineText = document.lineAt(i).text;
        text += lineText + ' ';
        
        // Track parentheses to know when signature is complete
        for (const char of lineText) {
            if (char === '(') {
                foundOpenParen = true;
                parenDepth++;
            } else if (char === ')') {
                parenDepth--;
                if (foundOpenParen && parenDepth === 0) {
                    // Found complete signature
                    break;
                }
            }
        }
        
        if (foundOpenParen && parenDepth === 0) {
            break;
        }
    }

    // Normalize whitespace
    text = text.replace(/\s+/g, ' ');

    // Remove annotations before parsing (to avoid issues with annotations containing parentheses)
    // This handles both single-line and multi-line annotations
    // Note: We need to be careful with nested parentheses in annotations like @PathVariable("ownerId")
    // We'll remove annotations that appear before the method signature
    let textWithoutMethodAnnotations = text;
    
    // Find the method signature start (look for modifiers followed by return type and method name)
    const methodStartMatch = text.match(/(?:public|private|protected|static|final|abstract|synchronized|native|strictfp|\s)+(?:<[^>]+>\s+)?\w+(?:<[^>]+>)?\s+\w+\s*\(/);
    if (methodStartMatch) {
        const methodStartIndex = methodStartMatch.index || 0;
        // Remove annotations only before the method signature
        const beforeMethod = text.substring(0, methodStartIndex);
        const methodPart = text.substring(methodStartIndex);
        textWithoutMethodAnnotations = beforeMethod.replace(/@\w+(?:\([^()]*\))?\s*/g, '') + methodPart;
    }

    // First, find the class name to detect constructors
    const className = findClassNameAboveLine(document, lineNumber);

    // Method signature pattern:
    // [modifiers] [generics] returnType methodName(params) [throws...]
    // Extract parameters with proper handling of nested parentheses and annotations
    const methodPattern = /(?:public|private|protected|static|final|abstract|synchronized|native|strictfp|\s)*(?:<[^>]+>\s+)?(\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/;
    
    const methodMatch = textWithoutMethodAnnotations.match(methodPattern);
    if (!methodMatch) {
        return null;
    }
    
    // Extract parameters by finding the matching closing parenthesis
    const methodStart = methodMatch.index! + methodMatch[0].length;
    let paramDepth = 1;
    let paramEnd = methodStart;
    
    for (let i = methodStart; i < textWithoutMethodAnnotations.length && paramDepth > 0; i++) {
        const char = textWithoutMethodAnnotations[i];
        if (char === '(') paramDepth++;
        else if (char === ')') paramDepth--;
        if (paramDepth === 0) {
            paramEnd = i;
            break;
        }
    }
    
    const paramsStr = textWithoutMethodAnnotations.substring(methodStart, paramEnd).trim();

    const returnType = methodMatch[1];
    const methodName = methodMatch[2];

        // Skip keywords
        if (isKeyword(methodName)) {
        return null;
        }

        // Skip constructors: methodName equals className or returnType equals methodName
        if (className && methodName === className) {
        return null;
        }
        if (returnType === methodName) {
        return null;
        }

        const params = parseParameters(paramsStr);
        return {
            name: methodName,
            params: params,
            lineNumber: lineNumber
        };
}

/**
 * Quick check if a line looks like it might start a method definition.
 */
function looksLikeMethodStart(line: string): boolean {
    const trimmed = line.trim();
    
    // Empty lines or comments
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        return false;
    }
    
    // Import, package, class declarations
    if (trimmed.startsWith('import ') || trimmed.startsWith('package ') || 
        trimmed.includes(' class ') || trimmed.includes(' interface ') || trimmed.includes(' enum ')) {
        return false;
    }
    
    // Annotations on their own line
    if (trimmed.startsWith('@') && !trimmed.includes('(')) {
        return false;
    }
    
    // Look for method-like patterns: has a word followed by ( or
    // has modifiers like public/private/protected
    const hasModifier = /\b(public|private|protected)\b/.test(trimmed);
    const hasParenOrMethodLike = /\w+\s*\(/.test(trimmed) || /\w+\s+\w+\s*\(/.test(trimmed);
    
    return hasModifier || hasParenOrMethodLike;
}

/**
 * Find class name by searching upward from the given line.
 */
function findClassNameAboveLine(document: vscode.TextDocument, lineNumber: number): string | null {
    const classPattern = /(?:class|interface|enum)\s+(\w+)/;
    for (let line = lineNumber; line >= 0; line--) {
        const lineText = document.lineAt(line).text;
        const match = classPattern.exec(lineText);
        if (match) {
            return match[1];
        }
    }
    return null;
}

/**
 * Parse parameter types from a parameter string.
 * Example: "String name, int count, List<String> items" -> ["String", "int", "List"]
 */
function parseParameters(paramsStr: string): string[] {
    if (!paramsStr.trim()) {
        return [];
    }

    const params: string[] = [];
    let depth = 0;
    let current = '';

    for (const char of paramsStr) {
        if (char === '<') {
            depth++;
            current += char;
        } else if (char === '>') {
            depth--;
            current += char;
        } else if (char === ',' && depth === 0) {
            const param = extractTypeName(current.trim());
            if (param) {
                params.push(param);
            }
            current = '';
        } else {
            current += char;
        }
    }

    // Don't forget the last parameter
    const lastParam = extractTypeName(current.trim());
    if (lastParam) {
        params.push(lastParam);
    }

    return params;
}

/**
 * Extract the type name from a parameter declaration.
 * Example: "final String name" -> "String"
 * Example: "@Valid User user" -> "User"
 * Example: "List<String> items" -> "List"
 * Example: "Map<Integer, Map<String, ProductInfo>> inventoryData" -> "Map"
 */
function extractTypeName(param: string): string | null {
    if (!param) {
        return null;
    }

    // Remove annotations
    param = param.replace(/@\w+(?:\([^)]*\))?\s*/g, '');
    
    // Remove final keyword
    param = param.replace(/\bfinal\s+/g, '');
    
    param = param.trim();
    if (!param) {
        return null;
    }

    // Split into type and variable name, respecting generics depth
    // "Map<Integer, Map<String, ProductInfo>> inventoryData" -> type="Map<...>", varName="inventoryData"
    const { type } = splitTypeAndVarName(param);
    
    if (!type) {
        return null;
    }

            // Remove generic parameters for simpler matching
            // Keep only the base type name
    const baseType = removeGenerics(type);
    return baseType || null;
}

/**
 * Split a parameter declaration into type and variable name
 * Respects nested generics (tracks < > depth)
 */
function splitTypeAndVarName(param: string): { type: string | null; varName: string | null } {
    let depth = 0;
    let lastSpaceOutsideGenerics = -1;
    
    for (let i = 0; i < param.length; i++) {
        const char = param[i];
        if (char === '<') {
            depth++;
        } else if (char === '>') {
            depth--;
        } else if (char === ' ' && depth === 0) {
            lastSpaceOutsideGenerics = i;
        }
    }
    
    if (lastSpaceOutsideGenerics === -1) {
        // No space found outside generics - just return the whole thing as type
        return { type: param, varName: null };
    }
    
    const type = param.substring(0, lastSpaceOutsideGenerics).trim();
    const varName = param.substring(lastSpaceOutsideGenerics + 1).trim();
    
    // Skip modifiers
    if (isModifier(type)) {
        return splitTypeAndVarName(varName);
        }
    
    return { type, varName };
}

/**
 * Remove generics from a type, handling nested generics properly
 * e.g., "Map<Integer, Map<String, Hoge>>" -> "Map"
 */
function removeGenerics(type: string): string {
    let result = '';
    let depth = 0;
    
    for (const char of type) {
        if (char === '<') {
            depth++;
        } else if (char === '>') {
            depth--;
        } else if (depth === 0) {
            result += char;
        }
    }
    
    return result.trim();
}

/**
 * Find the enclosing class name by searching upward from the given position.
 */
function findEnclosingClassName(
    document: vscode.TextDocument,
    position: vscode.Position
): string | null {
    // Search upward for class/interface/enum declaration
    const classPattern = /(?:public|private|protected|abstract|final|static|\s)*(?:class|interface|enum)\s+(\w+)/;

    for (let line = position.line; line >= 0; line--) {
        const lineText = document.lineAt(line).text;
        const match = classPattern.exec(lineText);
        if (match) {
            return match[1];
        }
    }

    return null;
}

/**
 * Class/interface/enum declaration line pattern.
 * Anchored to line start to prevent false-positive matches in comments or mid-line identifiers
 * (e.g. "subclassOf", "// This class ...").
 * Each modifier must be followed by whitespace, preventing partial-word matches.
 */
const CLASS_DECL_LINE_PATTERN =
    /^\s*(?:(?:public|private|protected|abstract|final|static|sealed|non-sealed)\s+)*(?:class|interface|enum|record)\s+(\w+)/;

/**
 * Collect enclosing class/interface/enum names from cursor line upward (innermost to outermost), then reverse to outer→inner.
 * Used to build FQN for nested classes as package.Outer$Inner.
 */
function findEnclosingClassChain(
    document: vscode.TextDocument,
    position: vscode.Position
): string[] {
    const chain: string[] = [];
    for (let line = position.line; line >= 0; line--) {
        const lineText = document.lineAt(line).text;
        const match = lineText.match(CLASS_DECL_LINE_PATTERN);
        if (match) {
            chain.push(match[1]);
        }
    }
    return chain.reverse();
}

/**
 * Resolve the fully qualified class name when the cursor is on a class/interface/enum declaration line.
 * Initial version: only the line that contains the class keyword and name is valid (not body lines).
 * Returns e.g. "com.example.HogeController" or "com.example.Outer$Inner" for nested classes.
 */
export async function resolveClassAtCursor(
    editor: vscode.TextEditor
): Promise<string | null> {
    const document = editor.document;
    const position = editor.selection.active;
    const lineText = document.lineAt(position.line).text;

    if (!CLASS_DECL_LINE_PATTERN.test(lineText)) {
        return null;
    }
    const packageName = findPackageName(document);
    const chain = findEnclosingClassChain(document, position);
    if (chain.length === 0) {
        return null;
    }
    const fqn = packageName ? packageName + '.' + chain.join('$') : chain.join('$');
    return fqn;
}

/**
 * Resolve class at cursor line or on one of the next few lines below (e.g. when cursor is on an annotation above the class).
 * Only searches downward to avoid false positives from unrelated class declarations above.
 */
export async function resolveClassAtCursorOrNextLines(
    editor: vscode.TextEditor,
    maxLinesDown: number = 5
): Promise<string | null> {
    const document = editor.document;
    const position = editor.selection.active;

    for (let lineOffset = 0; lineOffset <= maxLinesDown; lineOffset++) {
        const line = position.line + lineOffset;
        if (line >= document.lineCount) break;
        const lineText = document.lineAt(line).text;
        if (!CLASS_DECL_LINE_PATTERN.test(lineText)) continue;
        const posOnLine = new vscode.Position(line, 0);
        const packageName = findPackageName(document);
        const chain = findEnclosingClassChain(document, posOnLine);
        if (chain.length === 0) continue;
        const fqn = packageName ? packageName + '.' + chain.join('$') : chain.join('$');
        return fqn;
    }
    return null;
}

function isKeyword(word: string): boolean {
    const keywords = [
        'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
        'try', 'catch', 'finally', 'throw', 'throws', 'return', 'break',
        'continue', 'new', 'this', 'super', 'class', 'interface', 'enum',
        'extends', 'implements', 'import', 'package', 'public', 'private',
        'protected', 'static', 'final', 'abstract', 'synchronized',
        'volatile', 'transient', 'native', 'strictfp', 'assert', 'void',
        'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double'
    ];
    return keywords.includes(word);
}

function isModifier(word: string): boolean {
    const modifiers = [
        'public', 'private', 'protected', 'static', 'final', 'abstract',
        'synchronized', 'volatile', 'transient', 'native', 'strictfp'
    ];
    return modifiers.includes(word);
}

/**
 * Find the package name from the document.
 */
function findPackageName(document: vscode.TextDocument): string | null {
    const packagePattern = /^\s*package\s+([\w.]+)\s*;/;
    for (let line = 0; line < Math.min(document.lineCount, 20); line++) {
        const lineText = document.lineAt(line).text;
        const match = packagePattern.exec(lineText);
        if (match) {
            return match[1];
        }
    }
    return null;
}

/**
 * Parse import statements from the document.
 * Returns a map from simple class name to fully qualified name.
 */
function parseImports(document: vscode.TextDocument): Map<string, string> {
    const imports = new Map<string, string>();
    const importPattern = /^\s*import\s+([\w.]+)\s*;/;
    
    for (let line = 0; line < Math.min(document.lineCount, 100); line++) {
        const lineText = document.lineAt(line).text;
        
        // Stop at class declaration
        if (/\b(class|interface|enum)\b/.test(lineText)) {
            break;
        }
        
        const match = importPattern.exec(lineText);
        if (match) {
            const fqn = match[1];
            const simpleName = fqn.substring(fqn.lastIndexOf('.') + 1);
            imports.set(simpleName, fqn);
        }
    }
    
    return imports;
}

/**
 * Resolve a simple type name to its fully qualified name.
 */
function resolveTypeName(
    typeName: string,
    packageName: string | null,
    imports: Map<string, string>
): string {
    // Handle array types
    let arraySuffix = '';
    if (typeName.endsWith('[]')) {
        arraySuffix = '[]';
        typeName = typeName.slice(0, -2);
    }
    
    // Handle generic types - extract base type
    let genericSuffix = '';
    const genericMatch = typeName.match(/^(\w+)(<.+>)$/);
    if (genericMatch) {
        typeName = genericMatch[1];
        // Note: we don't resolve generic parameters for simplicity
        genericSuffix = genericMatch[2];
    }
    
    // Primitive types stay as-is
    if (isPrimitiveType(typeName)) {
        return typeName + arraySuffix;
    }
    
    // Check imports first
    if (imports.has(typeName)) {
        return imports.get(typeName)! + genericSuffix + arraySuffix;
    }
    
    // java.lang types are implicitly imported
    const javaLangTypes = [
        'String', 'Object', 'Integer', 'Long', 'Double', 'Float', 'Boolean',
        'Byte', 'Short', 'Character', 'Number', 'Class', 'Enum', 'Throwable',
        'Exception', 'RuntimeException', 'Error', 'StringBuilder', 'StringBuffer',
        'Thread', 'Runnable', 'Comparable', 'Iterable', 'Math', 'System'
    ];
    if (javaLangTypes.includes(typeName)) {
        return 'java.lang.' + typeName + genericSuffix + arraySuffix;
    }
    
    // Check if it looks like it already has a package (contains dots)
    if (typeName.includes('.')) {
        return typeName + genericSuffix + arraySuffix;
    }
    
    // Assume same package if no import found
    if (packageName) {
        return packageName + '.' + typeName + genericSuffix + arraySuffix;
    }
    
    // Fallback: return as-is
    return typeName + genericSuffix + arraySuffix;
}

/**
 * Check if a type name is a primitive type.
 */
function isPrimitiveType(typeName: string): boolean {
    const primitives = ['int', 'long', 'double', 'float', 'boolean', 'byte', 'short', 'char', 'void'];
    return primitives.includes(typeName);
}

/**
 * Resolve method signature from a document and line number.
 * This is used by the API command for CallCanvas Viewer integration.
 * Returns a string in the format: "com.example.ClassName#methodName(java.lang.String,int)"
 */
export async function resolveMethodFromDocument(
    document: vscode.TextDocument,
    lineNumber: number
): Promise<string | null> {
    // Create a position at the specified line
    const position = new vscode.Position(lineNumber - 1, 0);

    // Try to find method definition at or near the position
    const methodInfo = findMethodAtPosition(document, position);
    if (!methodInfo) {
        return null;
    }

    // Find the enclosing class name (simple name)
    const simpleClassName = findEnclosingClassName(document, position);
    if (!simpleClassName) {
        return null;
    }

    // Get the package name from the file
    const packageName = findPackageName(document);
    
    // Build fully qualified class name
    const className = packageName ? `${packageName}.${simpleClassName}` : simpleClassName;

    // Get import statements for resolving parameter types
    const imports = parseImports(document);
    
    // Resolve parameter types to fully qualified names
    const resolvedParams = methodInfo.params.map(param => resolveTypeName(param, packageName, imports));

    return `${className}#${methodInfo.name}(${resolvedParams.join(',')})`;
}

