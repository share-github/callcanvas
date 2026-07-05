import { log } from './logger';

/**
 * Extract method/function name from code based on language
 */
export function extractMethodName(code: string, languageId: string): string | null {
    // Patterns for different languages
    const patterns: { [key: string]: RegExp[] } = {
        java: [
            // Java method: public void methodName(, private String methodName(, etc.
            /(?:public|private|protected|static|\s)+[\w<>\[\],\s]+\s+(\w+)\s*\(/,
            // Java interface method or simple method
            /^\s*(?:default\s+)?[\w<>\[\],\s]+\s+(\w+)\s*\(/m
        ],
        typescript: [
            // TypeScript/JavaScript: function name(, async function name(
            /(?:async\s+)?function\s+(\w+)\s*\(/,
            // Method: methodName( or async methodName(
            /(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/,
            // Arrow function: const name =
            /(?:const|let|var)\s+(\w+)\s*=/
        ],
        javascript: [
            /(?:async\s+)?function\s+(\w+)\s*\(/,
            /(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/,
            /(?:const|let|var)\s+(\w+)\s*=/
        ],
        python: [
            // Python: def method_name(
            /def\s+(\w+)\s*\(/
        ],
        kotlin: [
            // Kotlin: fun methodName(
            /fun\s+(\w+)\s*[<(]/
        ],
        go: [
            // Go: func methodName( or func (r Receiver) methodName(
            /func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/
        ],
        rust: [
            // Rust: fn method_name( or pub fn method_name(
            /(?:pub\s+)?fn\s+(\w+)\s*[<(]/
        ],
        csharp: [
            // C#: public void MethodName(
            /(?:public|private|protected|internal|static|\s)+[\w<>\[\],\s]+\s+(\w+)\s*\(/
        ]
    };

    // Get patterns for the language, fallback to a generic pattern
    const langPatterns = patterns[languageId] || [
        /(?:function|def|fn|func)\s+(\w+)\s*\(/,
        /(?:public|private|protected|static|\s)+[\w<>\[\],\s]+\s+(\w+)\s*\(/
    ];

    for (const pattern of langPatterns) {
        const match = code.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }

    return null;
}

/**
 * Extract method signature from displayName, code, and filePath
 * displayName format: "ClassName # methodName" or "ClassName#methodName"
 * filePath format: "path/to/src/main/java/com/example/ClassName.java"
 * Returns: "com.example.ClassName#methodName(paramTypes)" with fully qualified class name
 */
export function extractMethodSignature(displayName: string, code: string, filePath?: string): string | null {
    // Parse displayName
    const displayMatch = displayName.match(/^(.+?)\s*#\s*(.+)$/);
    if (!displayMatch) {
        return null;
    }

    const simpleClassName = displayMatch[1].trim();
    const methodName = displayMatch[2].trim();

    // Try to extract fully qualified class name from filePath
    let className = simpleClassName;
    if (filePath) {
        const fqn = extractFqnFromFilePath(filePath);
        if (fqn) {
            className = fqn;
            log(`Resolved FQN from filePath: ${fqn}`);
        }
    }

    // Try to extract parameter types from code
    const paramTypes = extractParameterTypes(code, methodName);

    return `${className}#${methodName}(${paramTypes})`;
}

/**
 * Extract fully qualified class name from Java file path
 * e.g., "sample-app/src/main/java/com/example/demo/service/TodoService.java"
 *    -> "com.example.demo.service.TodoService"
 */
export function extractFqnFromFilePath(filePath: string): string | null {
    // Normalize path separators
    const normalizedPath = filePath.replace(/\\/g, '/');

    // Find src/main/java or src/java in the path
    const srcMainJavaIndex = normalizedPath.indexOf('src/main/java/');
    if (srcMainJavaIndex !== -1) {
        const classPath = normalizedPath.substring(srcMainJavaIndex + 'src/main/java/'.length);
        // Remove .java extension and convert / to .
        return classPath.replace(/\.java$/, '').replace(/\//g, '.');
    }

    const srcJavaIndex = normalizedPath.indexOf('src/java/');
    if (srcJavaIndex !== -1) {
        const classPath = normalizedPath.substring(srcJavaIndex + 'src/java/'.length);
        return classPath.replace(/\.java$/, '').replace(/\//g, '.');
    }

    return null;
}

/**
 * Extract parameter types from Java method code
 */
export function extractParameterTypes(code: string, methodName: string): string {
    // Normalize code: replace newlines with spaces for multi-line signatures
    const normalizedCode = code.replace(/\n/g, ' ').replace(/\s+/g, ' ');

    // Pattern for Java method signature (handles multi-line)
    // e.g., "public PageResult<TodoItem> search( String keyword, Boolean completed, ... )"
    const pattern = new RegExp(
        `(?:public|private|protected|static|final|synchronized|abstract|native|\\s)+` +
        `[\\w<>\\[\\],\\s]+\\s+${methodName}\\s*\\(([^)]*)\\)`,
        'i'
    );

    const match = normalizedCode.match(pattern);
    if (!match) {
        // Try simpler pattern
        const simplePattern = new RegExp(`${methodName}\\s*\\(([^)]*)\\)`, 'i');
        const simpleMatch = normalizedCode.match(simplePattern);
        if (!simpleMatch) {
            return '';
        }
        return parseParameterList(simpleMatch[1]);
    }

    return parseParameterList(match[1]);
}

/**
 * Parse parameter list and extract type names
 * Properly handles nested generics like Map<Integer, Map<String, Hoge>>
 * e.g., "Map<Integer, Map<String, Hoge>> hogeMap, String name" -> "Map,String"
 */
export function parseParameterList(paramList: string): string {
    if (!paramList || !paramList.trim()) {
        return '';
    }

    // Split by comma, but respect nested generics (track < > depth)
    const params: string[] = [];
    let depth = 0;
    let current = '';

    for (const char of paramList) {
        if (char === '<') {
            depth++;
            current += char;
        } else if (char === '>') {
            depth--;
            current += char;
        } else if (char === ',' && depth === 0) {
            if (current.trim()) {
                params.push(current.trim());
            }
            current = '';
        } else {
            current += char;
        }
    }

    // Don't forget the last parameter
    if (current.trim()) {
        params.push(current.trim());
    }

    const types: string[] = [];

    for (const param of params) {
        // Handle annotations: "@RequestBody OrderRequest request" -> "OrderRequest"
        const withoutAnnotations = param.replace(/@\w+(\([^)]*\))?\s*/g, '').trim();

        // Split by space (but preserve dots in fully qualified names)
        // e.g., "java.time.LocalDate dueDateFrom" -> ["java.time.LocalDate", "dueDateFrom"]
        const parts = withoutAnnotations.split(/\s+/);
        if (parts.length >= 2) {
            // The type is everything except the last part (parameter name)
            const type = parts.slice(0, -1).join(' ');
            // Remove generics for simpler matching: Map<Integer, Map<String, Hoge>> -> Map
            const cleanType = removeGenerics(type).trim();
            types.push(cleanType);
        } else if (parts.length === 1) {
            // Just the type without parameter name
            types.push(removeGenerics(parts[0]).trim());
        }
    }

    return types.join(',');
}

/**
 * Remove generics from a type, handling nested generics properly
 * e.g., "Map<Integer, Map<String, Hoge>>" -> "Map"
 */
export function removeGenerics(type: string): string {
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

    return result;
}

/**
 * Detect analysis language from file path (extension host side)
 */
export function detectAnalysisLanguage(filePath: string): 'java' | 'javascript' | 'typescript' | null {
    if (filePath.endsWith('.java')) return 'java';
    if (/\.(ts|tsx)$/.test(filePath)) return 'typescript';
    if (/\.(js|jsx|mjs|cjs)$/.test(filePath)) return 'javascript';
    return null;
}

/**
 * Extract JS/TS method signature from displayName for fallback
 * displayName format: "fileName # functionName" or "ClassName # methodName"
 */
export function extractMethodSignatureJS(displayName: string, filePath: string, startLine: number): string | null {
    const match = displayName.match(/^(.+?)\s*#\s*(.+)$/);
    if (!match) return null;
    const functionName = match[2].trim();
    return `${filePath}#${functionName}:${startLine}`;
}
