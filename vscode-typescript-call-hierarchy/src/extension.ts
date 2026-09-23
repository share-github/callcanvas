import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as ts from 'typescript';
import { ProjectContext, CallCanvasJSON, CallCanvasMetadata } from './types';
import { detectProject } from './projectDetector';
import { resolveFunctionAtLine } from './functionResolver';
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
    outputChannel = vscode.window.createOutputChannel('TS Call Hierarchy');

    const openViewerCommand = vscode.commands.registerCommand(
        'tsCallHierarchy.openCallCanvasViewer',
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

    const resolveMethodSignatureCommand = vscode.commands.registerCommand(
        'tsCallHierarchy.resolveMethodSignature',
        async (filePath: string, lineNumber: number): Promise<string | null> => {
            try {
                log(`[API] resolveMethodSignature: ${filePath}:${lineNumber}`);

                const absolutePath = resolveFilePath(filePath);
                if (!absolutePath || !fs.existsSync(absolutePath)) {
                    log(`[API] File not found: ${filePath}`);
                    return null;
                }

                const projectContext = getOrDetectProject(absolutePath);
                const program = getOrCreateProgram(projectContext);

                const sourceFile = program.getSourceFile(absolutePath);
                if (!sourceFile) {
                    log(`[API] Source file not in program: ${absolutePath}`);
                    return null;
                }

                const funcInfo = resolveFunctionAtLine(sourceFile, lineNumber, projectContext.rootDir);
                log(`[API] resolveMethodSignature: ${filePath}:${lineNumber} -> ${funcInfo?.signature || 'null'}`);
                return funcInfo?.signature ?? null;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log(`[API] resolveMethodSignature error: ${message}`);
                return null;
            }
        }
    );

    const analyzeMethodCommand = vscode.commands.registerCommand(
        'tsCallHierarchy.analyzeMethod',
        async (params: {
            filePath: string;
            methodSignature: string;
            depth?: number;
        }): Promise<{ success: boolean; data?: CallCanvasJSON; error?: string; timing?: Array<{ phase: string; elapsedMs: number; detail?: string }> }> => {
            try {
                const analysisDepth =
                    params.depth ??
                    vscode.workspace.getConfiguration('tsCallHierarchy').get<number>('depth', 5);
                log(`[API] analyzeMethod: ${params.methodSignature} (depth=${analysisDepth})`);

                const perfEnabled = vscode.workspace.getConfiguration('callcanvas').get<boolean>('performanceLog', false);
                const timing: Array<{ phase: string; elapsedMs: number; detail?: string }> = [];

                const hashIndex = params.methodSignature.indexOf('#');
                const colonIndex = params.methodSignature.lastIndexOf(':');
                if (hashIndex === -1 || colonIndex === -1) {
                    return { success: false, error: 'Invalid signature format' };
                }

                const absoluteFilePath = resolveFilePath(params.filePath);
                if (!absoluteFilePath) {
                    return { success: false, error: `File not found: ${params.filePath}` };
                }

                let t0 = 0;
                if (perfEnabled) { t0 = Date.now(); }
                const projectContext = getOrDetectProject(absoluteFilePath);
                if (perfEnabled) { timing.push({ phase: 'projectDetection', elapsedMs: Date.now() - t0, detail: `files:${projectContext.files.length}` }); }

                let t1 = 0;
                if (perfEnabled) { t1 = Date.now(); }
                const program = getOrCreateProgram(projectContext);
                if (perfEnabled) { timing.push({ phase: 'programCreation', elapsedMs: Date.now() - t1 }); }

                let t2 = 0;
                if (perfEnabled) { t2 = Date.now(); }
                const splitNested = vscode.workspace.getConfiguration('tsCallHierarchy').get<boolean>('nestedLocalWindows', true);
                const callGraph = analyzeCallHierarchyBySignature(
                    program,
                    params.methodSignature,
                    projectContext.rootDir,
                    analysisDepth,
                    log,
                    splitNested
                );
                if (perfEnabled) { timing.push({ phase: 'analysis', elapsedMs: Date.now() - t2, detail: `functions:${callGraph.functions.size},calls:${callGraph.calls.length}` }); }

                if (callGraph.functions.size === 0) {
                    return { success: false, error: 'No functions found', ...(perfEnabled ? { timing } : {}) };
                }

                let t3 = 0;
                if (perfEnabled) { t3 = Date.now(); }
                const metadata: CallCanvasMetadata = {
                    rootDir: projectContext.rootDir,
                    projectType: projectContext.type,
                };
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                const parentNestedOmit = vscode.workspace.getConfiguration('tsCallHierarchy').get<boolean>('parentNestedOmitDisplay', true);
                const callcanvasData = formatAsCallCanvasJSON(callGraph, params.methodSignature, metadata, workspaceRoot, {
                    parentNestedOmitDisplay: parentNestedOmit,
                    depth: analysisDepth,
                });
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
        resolveMethodSignatureCommand,
        analyzeMethodCommand,
        outputChannel
    );

    log('TS Call Hierarchy extension activated');
}

async function exportCallCanvasInternal(): Promise<string | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return null;
    }

    const filePath = editor.document.uri.fsPath;
    const line = editor.selection.active.line + 1;

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
            const tsIso = new Date().toISOString();
            let pline = `[PERF] ${tsIso} | exportCallCanvas | phase=${phase} | elapsed=${Math.round(elapsedMs)}ms`;
            if (detail) { pline += ` | detail=${detail}`; }
            perfChannel.appendLine(pline);
        };
        let totalStart = 0;
        if (perfEnabled) {
            totalStart = Date.now();
            perfChannel!.appendLine('=== exportCallCanvas (typescript) ===');
        }

        let t0 = 0;
        if (perfEnabled) { t0 = Date.now(); }
        const projectContext = getOrDetectProject(filePath);
        perfLog('projectDetection', Date.now() - t0, `files:${projectContext.files.length}`);

        log(`Project type: ${projectContext.type}, Files: ${projectContext.files.length}`);

        if (projectContext.files.length > 500) {
            const proceed = await vscode.window.showWarningMessage(
                `${projectContext.files.length} files found. Consider tightening tsconfig.json include. Continue?`,
                'Continue', 'Cancel'
            );
            if (proceed !== 'Continue') { return null; }
        }

        projectContextCache.set(filePath, projectContext);
        programCache.delete(projectContext.rootDir);

        const config = vscode.workspace.getConfiguration('tsCallHierarchy');
        const maxDepth = config.get<number>('depth', 5);
        const splitNested = config.get<boolean>('nestedLocalWindows', true);

        let t1 = 0;
        if (perfEnabled) { t1 = Date.now(); }
        const program = createProgram(projectContext);
        programCache.set(projectContext.rootDir, { program, context: projectContext });
        perfLog('programCreation', Date.now() - t1);

        let t2 = 0;
        if (perfEnabled) { t2 = Date.now(); }
        const callGraph = analyzeCallHierarchy(
            program, filePath, line, projectContext.rootDir, maxDepth, log, splitNested
        );
        perfLog('analysis', Date.now() - t2, `functions:${callGraph.functions.size},calls:${callGraph.calls.length}`);

        if (callGraph.functions.size === 0) {
            vscode.window.showWarningMessage('カーソル位置に関数が見つかりませんでした');
            return null;
        }

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

        const metadata: CallCanvasMetadata = {
            rootDir: projectContext.rootDir,
            projectType: projectContext.type,
        };

        let t3 = 0;
        if (perfEnabled) { t3 = Date.now(); }
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const parentNestedOmit = config.get<boolean>('parentNestedOmitDisplay', true);
        const callcanvasData = formatAsCallCanvasJSON(callGraph, rootFunc.signature, metadata, workspaceRoot, {
            parentNestedOmitDisplay: parentNestedOmit,
            depth: maxDepth,
        });
        perfLog('formatting', Date.now() - t3, `windows:${callcanvasData.windows.length}`);

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

function resolveFilePath(filePath: string): string | null {
    if (path.isAbsolute(filePath)) {
        return fs.existsSync(filePath) ? filePath : null;
    }

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
    const program = createProgram(projectContext);
    programCache.set(projectContext.rootDir, { program, context: projectContext });
    return program;
}

export function deactivate(): void {
    projectContextCache.clear();
    programCache.clear();
}
