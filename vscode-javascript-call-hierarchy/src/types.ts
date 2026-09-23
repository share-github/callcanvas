/**
 * Project context types for JavaScript/TypeScript call hierarchy analysis
 */

export interface ProjectContext {
    type: 'tsconfig' | 'html' | 'package' | 'single';
    files: string[];
    rootDir: string;
    htmlPath?: string;
    compilerOptions?: import('typescript').CompilerOptions;
}

export interface FunctionInfo {
    /** Unique signature: filePath#[ClassName.]functionName:startLine */
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
    /** Start line (1-based) */
    startLine: number;
    /** End line (1-based) */
    endLine: number;
    /** Source code of the function */
    code: string;
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

export interface CallGraph {
    functions: Map<string, FunctionInfo>;
    calls: CallInfo[];
}

/** The analysis that produced a canvas — replayed by the Viewer's ルート再解析. */
export interface CallCanvasAnalysisRecord {
    language: string;
    /** Root function signature handed to the analyzer. */
    root: string;
    /** Root source file, same relative convention as window.filePath. */
    rootFilePath?: string;
    /** Window id of the root at export time. */
    rootWindowId?: string;
    direction: string;
    depth?: number;
}

/** Metadata embedded in CallCanvas JSON for context re-use (e.g. Analyze Next Level) */
export interface CallCanvasMetadata {
    /** Absolute path of the HTML file that defined the project scope (vanilla JS only) */
    htmlPath?: string;
    /** Absolute path of the project root directory */
    rootDir?: string;
    /** How the project scope was detected */
    projectType?: 'html' | 'tsconfig' | 'package' | 'single';
}

/** CallCanvas JSON format (same as Java extension output) */
export interface CallCanvasJSON {
    autoLayout: boolean;
    metadata?: CallCanvasMetadata;
    windows: CallCanvasWindow[];
    connections: CallCanvasConnection[];
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
}

export interface CallCanvasConnection {
    id: string;
    from: string;
    to: string;
    callLine: number;
    callEndLine: number;
}

export interface ScriptReference {
    /** Resolved absolute path to the JS file */
    absolutePath: string;
    /** Original src attribute value */
    src: string;
    /** Whether it's a classic script (non-module) */
    isClassic: boolean;
}
