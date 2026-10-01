import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as ts from 'typescript';
import { ProjectContext, CallCanvasJSON, CallCanvasMetadata } from './types';
import { detectProject } from './projectDetector';
import { findAllHtmlsForJsFile, collectScriptsFromTemplateTree } from './htmlProjectResolver';
import { findProjectRoot, collectIncludeEdges, IncludeEdge } from './templateIncludeResolver';
import { formatIncludeMapAsCallCanvasJSON } from './includeMapFormatter';
import { resolveFunctionAtLine, resolveSignaturesAtLines } from './functionResolver';
import { createProgram, analyzeCallHierarchy, analyzeCallHierarchyBySignature } from './analyzer';
import { formatAsCallCanvasJSON } from './callcanvasFormatter';

let outputChannel: vscode.OutputChannel;

/** Cache project contexts for API calls */
const projectContextCache = new Map<string, ProjectContext>();
/** Cache ts.Program instances keyed by rootDir */
const programCache = new Map<string, { program: ts.Program; context: ProjectContext }>();

function log(message: string): void {
    outputChannel?.appendLine(message);
}

export function activate(context: vscode.ExtensionContext): void {
    outputChannel = vscode.window.createOutputChannel('JS Call Hierarchy');

    // Command: CallCanvas: Open Viewer with File (analyze + open viewer in one step)
    const openViewerCommand = vscode.commands.registerCommand(
        'jsCallHierarchy.openCallCanvasViewer',
        async () => {
            const jsonPath = await exportCallCanvasInternal();
            if (jsonPath) {
                await vscode.commands.executeCommand(
                    'callcanvas.openViewerWithFile',
                    vscode.Uri.file(jsonPath)
                );
            }
        }
    );


    // Command: Export HTML Include Map as CallCanvas JSON
    const exportIncludeMapCommand = vscode.commands.registerCommand(
        'jsCallHierarchy.exportIncludeMap',
        async () => {
            const jsonPath = await exportIncludeMapInternal();
            if (jsonPath) {
                await vscode.commands.executeCommand(
                    'callcanvas.openViewerWithFile',
                    vscode.Uri.file(jsonPath)
                );
            }
        }
    );

    // API Command: Resolve function signature from file path and line number
    const resolveMethodSignatureCommand = vscode.commands.registerCommand(
        'jsCallHierarchy.resolveMethodSignature',
        async (filePath: string, lineNumber: number): Promise<string | null> => {
            try {
                log(`[API] resolveMethodSignature: ${filePath}:${lineNumber}`);

                const absolutePath = resolveFilePath(filePath);
                if (!absolutePath || !fs.existsSync(absolutePath)) {
                    log(`[API] File not found: ${filePath}`);
                    return null;
                }

                // Get or create project context
                const projectContext = getOrDetectProject(absolutePath);
                const program = getOrCreateProgram(projectContext);

                const signatures = resolveSignaturesAtLines(program, absolutePath, [lineNumber], projectContext.rootDir);
                if (!signatures) {
                    log(`[API] Source file not in program: ${absolutePath}`);
                    return null;
                }

                log(`[API] resolveMethodSignature: ${filePath}:${lineNumber} -> ${signatures[0] || 'null'}`);
                return signatures[0];
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log(`[API] resolveMethodSignature error: ${message}`);
                return null;
            }
        }
    );

    // API Command: resolveMethodSignature for several lines of one file (one program instead of one per line).
    // Used by the Viewer's change set canvas to map diff hunks to functions.
    const resolveMethodSignaturesCommand = vscode.commands.registerCommand(
        'jsCallHierarchy.resolveMethodSignatures',
        async (filePath: string, lineNumbers: number[]): Promise<(string | null)[] | null> => {
            try {
                log(`[API] resolveMethodSignatures: ${filePath} (${lineNumbers.length} lines)`);

                const absolutePath = resolveFilePath(filePath);
                if (!absolutePath || !fs.existsSync(absolutePath)) {
                    log(`[API] File not found: ${filePath}`);
                    return null;
                }

                const projectContext = getOrDetectProject(absolutePath);
                const program = getOrCreateProgram(projectContext);

                const signatures = resolveSignaturesAtLines(program, absolutePath, lineNumbers, projectContext.rootDir);
                if (!signatures) {
                    log(`[API] Source file not in program: ${absolutePath}`);
                }
                return signatures;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log(`[API] resolveMethodSignatures error: ${message}`);
                return null;
            }
        }
    );

    // API Command: include edges of a template (the same nodes/edges as Export HTML Include Map)
    const collectIncludeEdgesCommand = vscode.commands.registerCommand(
        'jsCallHierarchy.collectIncludeEdges',
        async (filePath: string): Promise<{ success: boolean; nodes?: string[]; edges?: IncludeEdge[]; error?: string }> => {
            try {
                const absolutePath = resolveFilePath(filePath);
                if (!absolutePath) {
                    return { success: false, error: `File not found: ${filePath}` };
                }
                if (!TEMPLATE_EXTENSIONS_SET.has(path.extname(absolutePath).toLowerCase())) {
                    return { success: false, error: `Not a template file: ${filePath}` };
                }
                const projectRoot = findProjectRoot(path.dirname(absolutePath)) ?? path.dirname(absolutePath);
                const { nodes, edges } = collectIncludeEdges(absolutePath, projectRoot);
                log(`[API] collectIncludeEdges: ${filePath} -> nodes ${nodes.length}, edges ${edges.length}`);
                return { success: true, nodes, edges };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log(`[API] collectIncludeEdges error: ${message}`);
                return { success: false, error: message };
            }
        }
    );

    // API Command: Analyze method and return CallCanvas JSON data
    const analyzeMethodCommand = vscode.commands.registerCommand(
        'jsCallHierarchy.analyzeMethod',
        async (params: {
            filePath: string;
            methodSignature: string;
            depth?: number;
            htmlPath?: string;  // Explicit HTML context for vanilla JS
        }): Promise<{ success: boolean; data?: CallCanvasJSON; error?: string; timing?: Array<{ phase: string; elapsedMs: number; detail?: string }> }> => {
            try {
                const analysisDepth =
                    params.depth ??
                    vscode.workspace.getConfiguration('jsCallHierarchy').get<number>('depth', 5);
                log(`[API] analyzeMethod: ${params.methodSignature} (depth=${analysisDepth}, htmlPath=${params.htmlPath || 'auto'})`);

                const perfEnabled = vscode.workspace.getConfiguration('callcanvas').get<boolean>('performanceLog', false);
                const timing: Array<{ phase: string; elapsedMs: number; detail?: string }> = [];

                const hashIndex = params.methodSignature.indexOf('#');
                const colonIndex = params.methodSignature.lastIndexOf(':');
                if (hashIndex === -1 || colonIndex === -1) {
                    return { success: false, error: 'Invalid signature format' };
                }

                // Get the absolute file path
                const absoluteFilePath = resolveFilePath(params.filePath);
                if (!absoluteFilePath) {
                    return { success: false, error: `File not found: ${params.filePath}` };
                }

                // Build project context: use explicit htmlPath if provided, else auto-detect
                let t0 = 0;
                if (perfEnabled) { t0 = Date.now(); }
                let projectContext: ProjectContext;
                if (params.htmlPath && fs.existsSync(params.htmlPath)) {
                    projectContext = buildContextFromHtml(params.htmlPath);
                    log(`[API] Using provided htmlPath: ${params.htmlPath}`);
                } else {
                    projectContext = getOrDetectProject(absoluteFilePath);
                }
                if (perfEnabled) { timing.push({ phase: 'projectDetection', elapsedMs: Date.now() - t0, detail: `files:${projectContext.files.length}` }); }

                let t1 = 0;
                if (perfEnabled) { t1 = Date.now(); }
                const program = getOrCreateProgram(projectContext);
                if (perfEnabled) { timing.push({ phase: 'programCreation', elapsedMs: Date.now() - t1 }); }

                // Analyze
                let t2 = 0;
                if (perfEnabled) { t2 = Date.now(); }
                const callGraph = analyzeCallHierarchyBySignature(
                    program,
                    params.methodSignature,
                    projectContext.rootDir,
                    analysisDepth,
                    log
                );
                if (perfEnabled) { timing.push({ phase: 'analysis', elapsedMs: Date.now() - t2, detail: `functions:${callGraph.functions.size},calls:${callGraph.calls.length}` }); }

                if (callGraph.functions.size === 0) {
                    return { success: false, error: 'No functions found', ...(perfEnabled ? { timing } : {}) };
                }

                // Format (carry forward htmlPath in metadata so Viewer can keep propagating)
                let t3 = 0;
                if (perfEnabled) { t3 = Date.now(); }
                const metadata: CallCanvasMetadata = {
                    rootDir: projectContext.rootDir,
                    projectType: projectContext.type,
                    htmlPath: projectContext.htmlPath,
                };
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                const callcanvasData = formatAsCallCanvasJSON(callGraph, params.methodSignature, metadata, workspaceRoot, { depth: analysisDepth });
                if (perfEnabled) { timing.push({ phase: 'formatting', elapsedMs: Date.now() - t3, detail: `windows:${callcanvasData.windows.length}` }); }

                log(`[API] analyzeMethod success: ${callcanvasData.windows.length} windows`);
                return { success: true, data: callcanvasData, ...(perfEnabled ? { timing } : {}) };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log(`[API] analyzeMethod error: ${message}`);
                return { success: false, error: message };
            }
        }
    );

    context.subscriptions.push(
        openViewerCommand,
        exportIncludeMapCommand,
        resolveMethodSignatureCommand,
        resolveMethodSignaturesCommand,
        collectIncludeEdgesCommand,
        analyzeMethodCommand,
        outputChannel
    );

    log('JS Call Hierarchy extension activated');
}

/**
 * Detect project, showing QuickPick when multiple HTML files reference the target JS.
 * Returns null if the user cancelled.
 */
async function detectProjectWithHtmlSelection(filePath: string): Promise<ProjectContext | null> {
    const targetAbsolute = path.resolve(filePath);

    // First try tsconfig/jsconfig — no HTML selection needed
    const preliminary = detectProject(filePath);
    if (preliminary.type !== 'html') {
        // tsconfig, package, or single — no ambiguity
        return preliminary;
    }

    // HTML-based: check how many HTMLs reference this JS
    const allHtmls = findAllHtmlsForJsFile(targetAbsolute);
    if (allHtmls.length === 0) {
        // Fallback (detectProject already returned html type, reuse it)
        return preliminary;
    }

    if (allHtmls.length === 1) {
        return preliminary; // Only one → auto-select (same as before)
    }

    // Multiple HTMLs → QuickPick
    const items = allHtmls.map(h => ({
        label: path.basename(h.htmlPath),
        description: h.htmlPath,
        detail: `${h.scripts.length} scripts: ${h.scripts.map(s => path.basename(s.absolutePath)).join(', ')}`,
        htmlPath: h.htmlPath,
        scripts: h.scripts,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: '解析スコープを定義するテンプレートファイルを選択してください (HTML / JSP / FTL / Mayaa)',
        title: 'Template Project Scope',
    });
    if (!selected) { return null; }

    const rootDir = path.dirname(selected.htmlPath);
    const files = selected.scripts.map(s => s.absolutePath).filter(f => fs.existsSync(f));
    return {
        type: 'html',
        files,
        rootDir,
        htmlPath: selected.htmlPath,
    };
}

/**
 * Build a ProjectContext directly from a known template file path.
 * Follows include directives (JSP, Thymeleaf, FreeMarker, Mayaa) to collect
 * all script references reachable from the template tree.
 */
function buildContextFromHtml(htmlPath: string): ProjectContext {
    const templateDir = path.dirname(htmlPath);
    const projectRoot = findProjectRoot(templateDir) ?? templateDir;
    const scripts = collectScriptsFromTemplateTree(htmlPath, projectRoot);
    const rootDir = templateDir;
    const files = scripts.map(s => s.absolutePath).filter(f => fs.existsSync(f));
    const context: ProjectContext = { type: 'html', files, rootDir, htmlPath };
    // Cache by each JS file in scope
    for (const f of files) {
        projectContextCache.set(f, context);
    }
    return context;
}

/**
 * Core analysis logic: detect project, analyze call hierarchy, save JSON.
 * Returns the absolute path to the saved JSON file, or null if cancelled/failed.
 */
async function exportCallCanvasInternal(): Promise<string | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return null;
    }

    const filePath = editor.document.uri.fsPath;
    const line = editor.selection.active.line + 1; // 1-based

    log(`=== Export CallCanvas JSON ===`);
    log(`File: ${filePath}, Line: ${line}`);

    try {
        const perfEnabled = vscode.workspace.getConfiguration('callcanvas').get<boolean>('performanceLog', false);
        let perfChannel: vscode.OutputChannel | undefined;
        if (perfEnabled) {
            perfChannel = vscode.window.createOutputChannel('CallCanvas Performance');
        }
        const perfLog = (phase: string, elapsedMs: number, detail?: string) => {
            if (!perfEnabled || !perfChannel) { return; }
            const ts = new Date().toISOString();
            let line = `[PERF] ${ts} | exportCallCanvas | phase=${phase} | elapsed=${Math.round(elapsedMs)}ms`;
            if (detail) { line += ` | detail=${detail}`; }
            perfChannel.appendLine(line);
        };
        let totalStart = 0;
        if (perfEnabled) {
            totalStart = Date.now();
            perfChannel!.appendLine('=== exportCallCanvas (javascript) ===');
        }

        // Detect project (with HTML QuickPick for vanilla JS)
        let t0 = 0;
        if (perfEnabled) { t0 = Date.now(); }
        const projectContext = await detectProjectWithHtmlSelection(filePath);
        if (!projectContext) { return null; } // user cancelled
        perfLog('projectDetection', Date.now() - t0, `files:${projectContext.files.length}`);

        log(`Project type: ${projectContext.type}, Files: ${projectContext.files.length}`);

        if (projectContext.files.length > 500) {
            const proceed = await vscode.window.showWarningMessage(
                `${projectContext.files.length}ファイルが見つかりました。tsconfig.json/jsconfig.jsonの作成を推奨します。解析を続行しますか？`,
                'Continue', 'Cancel'
            );
            if (proceed !== 'Continue') { return null; }
        }

        // Cache the project context (clear stale entries first)
        projectContextCache.set(filePath, projectContext);
        programCache.delete(projectContext.rootDir);

        // Create fresh program (always re-create to reflect file changes)
        const config = vscode.workspace.getConfiguration('jsCallHierarchy');
        const maxDepth = config.get<number>('depth', 5);

        let t1 = 0;
        if (perfEnabled) { t1 = Date.now(); }
        const program = createProgram(projectContext);
        programCache.set(projectContext.rootDir, { program, context: projectContext });
        perfLog('programCreation', Date.now() - t1);

        // Analyze
        let t2 = 0;
        if (perfEnabled) { t2 = Date.now(); }
        const callGraph = analyzeCallHierarchy(
            program, filePath, line, projectContext.rootDir, maxDepth, log
        );
        perfLog('analysis', Date.now() - t2, `functions:${callGraph.functions.size},calls:${callGraph.calls.length}`);

        if (callGraph.functions.size === 0) {
            vscode.window.showWarningMessage('カーソル位置に関数が見つかりませんでした');
            return null;
        }

        // Find root signature
        const sourceFile = program.getSourceFile(filePath);
        if (!sourceFile) {
            vscode.window.showErrorMessage('Source file not found in program');
            return null;
        }
        const rootFunc = resolveFunctionAtLine(sourceFile, line, projectContext.rootDir);
        if (!rootFunc) {
            vscode.window.showErrorMessage('関数が見つかりませんでした');
            return null;
        }

        // Build metadata (htmlPath for vanilla JS, rootDir always)
        const metadata: CallCanvasMetadata = {
            rootDir: projectContext.rootDir,
            projectType: projectContext.type,
            htmlPath: projectContext.htmlPath,
        };

        // Format as CallCanvas JSON
        let t3 = 0;
        if (perfEnabled) { t3 = Date.now(); }
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const callcanvasData = formatAsCallCanvasJSON(callGraph, rootFunc.signature, metadata, workspaceRoot, { depth: maxDepth });
        perfLog('formatting', Date.now() - t3, `windows:${callcanvasData.windows.length}`);

        // Save JSON
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const baseDir = workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(filePath);
        const baseName = path.basename(filePath, path.extname(filePath));
        const funcName = rootFunc.functionName;
        const jsonFileName = `${baseName}_${funcName}_callcanvas.json`;
        const jsonPath = path.join(baseDir, jsonFileName);

        fs.writeFileSync(jsonPath, JSON.stringify(callcanvasData, null, 2), 'utf-8');

        log(`Saved: ${jsonPath}`);
        log(`Windows: ${callcanvasData.windows.length}, Connections: ${callcanvasData.connections.length}`);

        if (perfEnabled && perfChannel) {
            perfChannel.appendLine(`[PERF] ${new Date().toISOString()} | exportCallCanvas | TOTAL=${Math.round(Date.now() - totalStart)}ms`);
        }

        return jsonPath;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Error: ${message}`);
        vscode.window.showErrorMessage(`Export failed: ${message}`);
        return null;
    }
}

const TEMPLATE_EXTENSIONS_SET = new Set(['.html', '.htm', '.jsp', '.jspf', '.ftl', '.ftlh', '.mayaa']);

/**
 * Export include tree for the active template file as CallCanvas JSON.
 * Returns the absolute path to the saved JSON file, or null if cancelled/failed.
 */
async function exportIncludeMapInternal(): Promise<string | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return null;
    }

    const filePath = editor.document.uri.fsPath;
    const ext = path.extname(filePath).toLowerCase();
    if (!TEMPLATE_EXTENSIONS_SET.has(ext)) {
        vscode.window.showErrorMessage('テンプレートファイル（HTML/JSP/FTL）を開いてください');
        return null;
    }

    log(`=== Export Include Map ===`);
    log(`File: ${filePath}`);

    try {
        const projectRoot = findProjectRoot(path.dirname(filePath)) ?? path.dirname(filePath);
        const { nodes, edges } = collectIncludeEdges(filePath, projectRoot);

        if (nodes.length === 0) {
            vscode.window.showWarningMessage('Includeディレクティブが見つかりませんでした');
            return null;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const callcanvasData = formatIncludeMapAsCallCanvasJSON(nodes, edges, workspaceRoot);

        const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(filePath);
        const baseName = path.basename(filePath, path.extname(filePath));
        const jsonFileName = `${baseName}_include_map_callcanvas.json`;
        const jsonPath = path.join(baseDir, jsonFileName);

        fs.writeFileSync(jsonPath, JSON.stringify(callcanvasData, null, 2), 'utf-8');

        log(`Saved: ${jsonPath}`);
        log(`Nodes: ${nodes.length}, Edges: ${edges.length}`);

        return jsonPath;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Error: ${message}`);
        vscode.window.showErrorMessage(`Export failed: ${message}`);
        return null;
    }
}

function resolveFilePath(filePath: string): string | null {
    // If already absolute, use as is
    if (path.isAbsolute(filePath)) {
        return fs.existsSync(filePath) ? filePath : null;
    }

    // Try to resolve relative to workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        for (const folder of workspaceFolders) {
            const candidate = path.join(folder.uri.fsPath, filePath);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }

    return null;
}

function getOrDetectProject(absoluteFilePath: string): ProjectContext {
    const cached = projectContextCache.get(absoluteFilePath);
    if (cached) {
        return cached;
    }

    const context = detectProject(absoluteFilePath);
    projectContextCache.set(absoluteFilePath, context);
    return context;
}

function getOrCreateProgram(projectContext: ProjectContext): ts.Program {
    // Always create a fresh program to reflect file changes
    const program = createProgram(projectContext);
    programCache.set(projectContext.rootDir, { program, context: projectContext });
    return program;
}

export function deactivate(): void {
    projectContextCache.clear();
    programCache.clear();
}
