/**
 * Project context types for TypeScript call hierarchy analysis
 */

export interface ProjectContext {
    type: 'tsconfig' | 'package' | 'single';
    files: string[];
    rootDir: string;
    compilerOptions?: import('typescript').CompilerOptions;
}

export interface FunctionInfo {
    /**
     * Unique signature: filePath#[ClassName.]functionName:declarationLine
     * (line is the declaration keyword / anchor, not the CallCanvas snippet start).
     */
    signature: string;
    /** Display name: fileName # functionName or ClassName # methodName */
    displayName: string;
    /** Relative file path from project root */
    filePath: string;
    /** Absolute file path */
    absolutePath: string;
    /** Function name */
    functionName: string;
    /** Class name (if method) */
    className?: string;
    /**
     * 1-based line of the declaration anchor (`getStart`, first token of the declaration).
     * Used in signatures, Analyze Next Level, and `findFunctionNode` — excludes leading TSDoc lines.
     */
    declarationLine: number;
    /**
     * 1-based first line of `code` (leading TSDoc / line comments when present; no orphan blank lines after prior statements).
     */
    startLine: number;
    /** 1-based end line of the declaration (`getEnd`). */
    endLine: number;
    /** Source snippet from the CallCanvas snippet start through `getEnd` (TSDoc / line comments when present). */
    code: string;
    /**
     * When this function is a nested local (const arrow / nested function declaration under another
     * analyzed function), the parent function's `signature` for graph context.
     */
    nestedUnder?: string;
}

export interface CallInfo {
    /** Caller function signature */
    callerSignature: string;
    /** Callee function signature */
    calleeSignature: string;
    /** Line where the call occurs (1-based) */
    callLine: number;
    /** End line of the call (1-based) */
    callEndLine: number;
}

/** Static constant for CallCanvas Viewer tooltips (aligned with Java symbolIndex entries). */
export interface SymbolEntry {
    /** Source text of the literal (e.g. 3, "x", true) or string form for enums; omit if unknown */
    value?: string;
    /** Defining file path relative to project root (forward slashes) */
    qualifier: string;
    /** Type string from checker, or `"enum"` for enum members */
    type: string;
}

export interface CallGraph {
    functions: Map<string, FunctionInfo>;
    calls: CallInfo[];
    /** Map of tooltip keys (const name or Enum.Member) to definition info */
    symbolIndex: Record<string, SymbolEntry>;
}

/** Metadata embedded in CallCanvas JSON for context re-use (e.g. Analyze Next Level) */
export interface CallCanvasMetadata {
    /** Absolute path of the project root directory */
    rootDir?: string;
    /** How the project scope was detected */
    projectType?: 'tsconfig' | 'package' | 'single';
}

/** CallCanvas JSON format (same as Java extension output) */
export interface CallCanvasJSON {
    autoLayout: boolean;
    metadata?: CallCanvasMetadata;
    windows: CallCanvasWindow[];
    connections: CallCanvasConnection[];
    /** Optional: static constants for inline tooltips in the viewer */
    symbolIndex?: Record<string, SymbolEntry>;
}

/** Omitted nested-local body in a parent CallCanvas window (Viewer renders as gray rounded card). */
export interface CallCanvasNestedOmission {
    /** First 1-based file line of the omitted range (inclusive), same coordinates as window code lines */
    startLine: number;
    /** Last 1-based file line of the omitted range (inclusive) */
    endLine: number;
    /** One-line preview, e.g. `const onMessage = (e: MessageEvent) => {...` */
    previewText: string;
}

export interface CallCanvasWindow {
    id: string;
    displayName: string;
    filePath: string;
    language: string;
    code: string;
    startLine: number;
    endLine: number;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    collapsed?: boolean;
    /** When set, Viewer collapses these line ranges to a single preview row per entry (parent windows only). */
    nestedOmissions?: CallCanvasNestedOmission[];
}

export interface CallCanvasConnection {
    id: string;
    from: string;
    to: string;
    callLine: number;
    callEndLine: number;
}
