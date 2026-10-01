import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { resolveMethodAtCursor, resolveClassAtCursor, resolveClassAtCursorOrNextLines } from './methodResolver';
import { analyzeCallHierarchy, analyzeCallHierarchyForClass, setOutputChannel, resolveClasspathForModules } from './analyzer';
import { renderAsMarkdown } from './outputRenderer';
import { findMultiModuleRoot, findSubModules } from './moduleDiscovery';

// 出力チャンネルを作成（デバッグ情報表示用）
let outputChannel: vscode.OutputChannel;

/**
 * Get the workspace folder path that contains the given file/directory path.
 * When multiple folders contain the path, returns the most specific (longest) one.
 */
function getWorkspaceBoundary(filePath: string): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return undefined;
    const normalized = path.normalize(filePath);
    let best: string | undefined;
    for (const folder of folders) {
        const folderPath = path.normalize(folder.uri.fsPath);
        if (normalized.startsWith(folderPath) && (!best || folderPath.length > best.length)) {
            best = folderPath;
        }
    }
    return best;
}

/**
 * True if the given path is exactly one of the workspace folder paths.
 */
function isProjectRootAWorkspaceFolder(projectRoot: string): boolean {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return false;
    const normalized = path.normalize(projectRoot);
    return folders.some(f => path.normalize(f.uri.fsPath) === normalized);
}

/**
 * Check if a directory has Java build files (pom.xml or build.gradle)
 */
function hasJavaBuildFile(dir: string): boolean {
    return fs.existsSync(path.join(dir, 'pom.xml')) ||
           fs.existsSync(path.join(dir, 'build.gradle')) ||
           fs.existsSync(path.join(dir, 'build.gradle.kts'));
}

/**
 * Find project root from a file path by searching upwards for build files
 */
function findProjectRootFromFile(filePath: string): string | null {
    let projectRoot = path.dirname(filePath);
    const root = path.parse(projectRoot).root;
    
    // Search upwards for pom.xml or build.gradle
    while (projectRoot && projectRoot !== root) {
        const hasPom = fs.existsSync(path.join(projectRoot, 'pom.xml'));
        const hasGradle = fs.existsSync(path.join(projectRoot, 'build.gradle')) || 
                         fs.existsSync(path.join(projectRoot, 'build.gradle.kts'));
        
        if (hasPom || hasGradle) {
            return projectRoot;
        }
        
        projectRoot = path.dirname(projectRoot);
    }
    
    return null;
}

/**
 * Find project root for callcanvas output (same as analyzer: path before src/main/java).
 * Used to compute expected callcanvas_ClassName_methodName.json path.
 */
function findProjectRootForCallCanvas(filePath: string): string | null {
    const srcMainJava = path.sep + 'src' + path.sep + 'main' + path.sep + 'java';
    const idx = filePath.indexOf(srcMainJava);
    if (idx !== -1) {
        return filePath.substring(0, idx);
    }
    const srcIdx = filePath.indexOf(path.sep + 'src' + path.sep);
    if (srcIdx !== -1) {
        return filePath.substring(0, srcIdx);
    }
    return null;
}

/**
 * Parse method signature to simple class name and method name (matches DepQueryCli.java).
 * e.g. "com.example.OrderController#handleNewOrder(...)" -> { simpleClass: "OrderController", methodName: "handleNewOrder" }
 */
function parseMethodSignatureForCallCanvas(signature: string): { simpleClass: string; methodName: string } {
    if (!signature || !signature.includes('#')) {
        return { simpleClass: 'Unknown', methodName: 'Unknown' };
    }
    const hashIndex = signature.indexOf('#');
    const fullClassName = signature.substring(0, hashIndex);
    const afterHash = signature.substring(hashIndex + 1);
    const parenIndex = afterHash.indexOf('(');
    const methodName = parenIndex !== -1 ? afterHash.substring(0, parenIndex) : afterHash;
    const lastDotIndex = fullClassName.lastIndexOf('.');
    const simpleClass = lastDotIndex !== -1 ? fullClassName.substring(lastDotIndex + 1) : fullClassName;
    const method = methodName === '<init>' ? 'init' : methodName;
    return { simpleClass, methodName: method };
}

/**
 * Sanitize string for callcanvas filename (matches Java sanitizeForFilename).
 */
function sanitizeForCallCanvasFilename(input: string): string {
    if (!input || input.length === 0) {
        return 'Unknown';
    }
    let sanitized = input.replace(/[<>:"/\\|?*\[\](),{}\s]+/g, '_');
    sanitized = sanitized.replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (sanitized.length > 100) {
        sanitized = sanitized.substring(0, 100);
    }
    return sanitized.length === 0 ? 'Unknown' : sanitized;
}

/**
 * Compute expected path of callcanvas JSON file (same as JAR output).
 */
function getExpectedCallCanvasPath(projectRoot: string, methodSignature: string): string {
    const { simpleClass, methodName } = parseMethodSignatureForCallCanvas(methodSignature);
    const base = 'callcanvas_' + sanitizeForCallCanvasFilename(simpleClass) + '_' + sanitizeForCallCanvasFilename(methodName) + '.json';
    return path.join(projectRoot, 'build', 'call-hierarchy-output', base);
}

/** Return the expected class-level callcanvas JSON path (callcanvas_<SimpleClassName>.json). */
function getExpectedClassCallCanvasPath(projectRoot: string, classFqn: string): string {
    const lastDot = classFqn.lastIndexOf('.');
    const lastDollar = classFqn.lastIndexOf('$');
    const cut = Math.max(lastDot, lastDollar);
    const simpleClassName = cut >= 0 ? classFqn.substring(cut + 1) : classFqn;
    return path.join(projectRoot, 'build', 'call-hierarchy-output', 'callcanvas_' + simpleClassName + '.json');
}

/**
 * Validate cached callcanvas JSON by checking that filePath entries resolve to real files
 * under the project root. A stale cache generated with a different workspace root
 * (e.g. parent apps/) will have filePaths like "task-manager-coordinator/src/main/java/..."
 * that don't exist when resolved from the current project root.
 */
function isCallCanvasCacheValid(jsonPath: string, projectRoot: string): boolean {
    try {
        const raw = fs.readFileSync(jsonPath, 'utf-8');
        const data = JSON.parse(raw);
        const windows: { filePath?: string }[] = data.windows;
        if (!Array.isArray(windows) || windows.length === 0) {
            return false;
        }
        const first = windows[0];
        if (!first.filePath) {
            return false;
        }
        return fs.existsSync(path.resolve(projectRoot, first.filePath));
    } catch {
        return false;
    }
}

/** Build AnalyzerOptions from workspace configuration for class-level analysis. */
function buildClassAnalyzerOptions(depth: number): {
    depth: number;
    excludePatterns: string;
    javaPath: string;
    languageLevel: string;
    debug: boolean;
    quiet: boolean;
    timing: boolean;
    windowWidth: number;
} {
    const config = vscode.workspace.getConfiguration('javaCallHierarchy');
    const callcanvasConfig = vscode.workspace.getConfiguration('callcanvas');
    return {
        depth,
        excludePatterns: config.get<string>('excludePatterns', ''),
        javaPath: config.get<string>('javaPath', ''),
        languageLevel: config.get<string>('languageLevel', 'JAVA_21'),
        debug: config.get<boolean>('debug', false),
        quiet: config.get<boolean>('quiet', false),
        timing: config.get<boolean>('timing', false),
        windowWidth: callcanvasConfig.get<number>('windowWidth', 600)
    };
}

/**
 * Scan subdirectories for Java projects recursively
 */
function scanForProjects(
    dir: string, 
    projects: { name: string; path: string }[], 
    maxDepth: number,
    currentDepth: number = 0,
    visitedPaths: Set<string> = new Set(),
    workspaceFolders: Set<string> = new Set()
): void {
    if (currentDepth >= maxDepth) return;
    
    // Avoid visiting the same path multiple times
    const normalizedDir = path.normalize(dir);
    if (visitedPaths.has(normalizedDir)) return;
    visitedPaths.add(normalizedDir);
    
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            
            // Skip common directories that are unlikely to contain projects
            if (['.git', 'node_modules', '.vscode', '.idea', 'target', 'build', 'out', 'dist'].includes(entry.name)) {
                continue;
            }
            
            const subDir = path.join(dir, entry.name);
            
            // Check if this directory is a Java project
            if (hasJavaBuildFile(subDir)) {
                const normalizedSubDir = path.normalize(subDir);
                
                // Check if already added (avoid duplicates)
                const alreadyAdded = projects.some(p => path.normalize(p.path) === normalizedSubDir);
                if (!alreadyAdded) {
                    // Check if it's a multi-module root
                    const multiModuleRoot = findMultiModuleRoot(subDir, dir, path.normalize(dir) === getWorkspaceBoundary(subDir));
                    const normalizedMultiModuleRoot = multiModuleRoot ? path.normalize(multiModuleRoot) : null;
                    
                    // If the parent directory is a workspace folder, always add the project individually
                    const parentIsWorkspaceFolder = workspaceFolders.has(normalizedDir);
                    
                    if (multiModuleRoot && 
                        normalizedMultiModuleRoot !== normalizedSubDir && 
                        !parentIsWorkspaceFolder) {
                        // This is a submodule (but not directly under workspace folder), don't add it individually
                        // The multi-module root will be added when we scan its parent
                        continue;
                    }
                    
                    const isMultiModule = multiModuleRoot === subDir;
                    projects.push({
                        name: `${entry.name}${isMultiModule ? ' (multi-module)' : ''}`,
                        path: subDir
                    });
                }
            }
            
            // Recursively scan subdirectories
            scanForProjects(subDir, projects, maxDepth, currentDepth + 1, visitedPaths, workspaceFolders);
        }
    } catch (error) {
        // Silently ignore permission errors and other I/O errors
    }
}

/**
 * Find Java projects in the workspace
 */
function findJavaProjectsInWorkspace(): { name: string; path: string }[] {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return [];
    
    const projects: { name: string; path: string }[] = [];
    const visitedPaths = new Set<string>();
    const workspaceFolderPaths = new Set<string>();
    
    // Collect workspace folder paths
    for (const folder of workspaceFolders) {
        workspaceFolderPaths.add(path.normalize(folder.uri.fsPath));
    }
    
    for (const folder of workspaceFolders) {
        const folderPath = folder.uri.fsPath;
        const normalizedFolderPath = path.normalize(folderPath);
        
        // Check if workspace folder itself is a Java project
        if (hasJavaBuildFile(folderPath)) {
            const multiModuleRoot = findMultiModuleRoot(folderPath, folderPath);
            if (multiModuleRoot) {
                projects.push({ 
                    name: `${folder.name} (multi-module)`, 
                    path: multiModuleRoot 
                });
                visitedPaths.add(path.normalize(multiModuleRoot));
            } else {
                projects.push({ name: folder.name, path: folderPath });
                visitedPaths.add(normalizedFolderPath);
            }
        }
        
        // Scan subdirectories (depth 3 to catch nested projects)
        scanForProjects(folderPath, projects, 3, 0, visitedPaths, workspaceFolderPaths);
    }
    
    // Remove duplicates based on normalized paths
    const uniqueProjects: { name: string; path: string }[] = [];
    const seenPaths = new Set<string>();
    
    for (const project of projects) {
        const normalizedPath = path.normalize(project.path);
        if (!seenPaths.has(normalizedPath)) {
            seenPaths.add(normalizedPath);
            uniqueProjects.push(project);
        }
    }
    
    return uniqueProjects;
}

/** Index generation the bundled analyzer writes (CallIndex.CURRENT_VERSION in app/). Bump both together. */
const CALL_INDEX_VERSION = '1.3';

/**
 * Check if a usable call index exists for a project.
 * An index from another analyzer generation counts as missing so that callers rebuild it in the background
 * (the analyzer ignores such an index for analysis: e.g. 1.2 has no symbols/refs).
 */
function indexExists(projectRoot: string): boolean {
    const cacheDir = path.join(projectRoot, '.callcanvas-cache');
    if (!fs.existsSync(path.join(cacheDir, 'call-index.json'))) {
        return false;
    }
    let version: string | undefined;
    try {
        version = JSON.parse(fs.readFileSync(path.join(cacheDir, 'call-index.meta'), 'utf-8')).version;
    } catch {
        // no/broken meta: an old index (meta has existed since lazy loading) → rebuild
    }
    if (version !== CALL_INDEX_VERSION) {
        outputChannel?.appendLine(`[Auto-Index] Index at ${cacheDir} is version ${version ?? 'unknown'} (expected ${CALL_INDEX_VERSION}), treating as missing`);
        return false;
    }
    return true;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Java Call Hierarchy Analyzer is now active');
    
    // 出力チャンネルを作成してanalyzerに渡す
    outputChannel = vscode.window.createOutputChannel('Java Call Hierarchy');
    setOutputChannel(outputChannel);
    context.subscriptions.push(outputChannel);

    const extVersion = context.extension.packageJSON?.version || 'unknown';
    outputChannel.appendLine(`[Java Call Hierarchy] Extension v${extVersion} activated`);

    // Command: Analyze Call Hierarchy (Markdown output)
    const analyzeCommand = vscode.commands.registerCommand(
        'javaCallHierarchy.analyze',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor');
                return;
            }

            if (editor.document.languageId !== 'java') {
                vscode.window.showErrorMessage('This command only works with Java files');
                return;
            }

            try {
                // Show progress
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'Analyzing call hierarchy...',
                        cancellable: false
                    },
                    async (progress) => {
                        // 1. Get project root first
                        const currentFilePath = editor.document.uri.fsPath;
                        let projectRoot = path.dirname(currentFilePath);
                        
                        // Search upwards for pom.xml or build.gradle
                        while (projectRoot && projectRoot !== path.dirname(projectRoot)) {
                            const hasPom = fs.existsSync(path.join(projectRoot, 'pom.xml'));
                            const hasGradle = fs.existsSync(path.join(projectRoot, 'build.gradle')) || 
                                             fs.existsSync(path.join(projectRoot, 'build.gradle.kts'));
                            
                            if (hasPom || hasGradle) {
                                break;
                            }
                            
                            projectRoot = path.dirname(projectRoot);
                        }
                        
                        const wsBoundary = getWorkspaceBoundary(projectRoot);
                        const multiModuleRoot = findMultiModuleRoot(projectRoot, wsBoundary, true);
                        const finalProjectRoot = multiModuleRoot || projectRoot;
                        
                        // 1.5. Resolve method signature (Index逆引き優先、フォールバック対応)
                        progress.report({ message: 'Resolving method...' });
                        let methodSignature: string | null = null;
                        
                        // まずIndex逆引きを試行
                        if (indexExists(finalProjectRoot)) {
                            const lineNumber = editor.selection.active.line + 1;
                            methodSignature = await resolveFromIndex(currentFilePath, lineNumber, finalProjectRoot);
                            if (methodSignature) {
                                outputChannel.appendLine('[Method Resolution] Resolved from index: ' + methodSignature);
                            }
                        }
                        
                        // Index逆引きが失敗した場合は従来のmethodResolverにフォールバック
                        if (!methodSignature) {
                            outputChannel.appendLine('[Method Resolution] Index not available or resolution failed, falling back to methodResolver');
                            methodSignature = await resolveMethodAtCursor(editor);
                        }
                        
                        if (!methodSignature) {
                            const classFqn = await resolveClassAtCursor(editor);
                            const hint = classFqn
                                ? 'For class-level analysis, use command "Export Call Hierarchy as CallCanvas JSON (Class)" with cursor on the class declaration line.'
                                : 'Place cursor on a method name (e.g. getAll, create) or on the class declaration line for class-level export.';
                            vscode.window.showErrorMessage(
                                'Could not resolve method at cursor position. ' + hint
                            );
                            return;
                        }

                        // 2. Get configuration (resource-scoped so folder .vscode/settings.json is used)
                        const config = vscode.workspace.getConfiguration('javaCallHierarchy', editor.document.uri);
                        const options = {
                            depth: config.get<number>('depth', 5),
                            excludePatterns: config.get<string>('excludePatterns', ''),
                            javaPath: config.get<string>('javaPath', ''),
                            languageLevel: config.get<string>('languageLevel', 'JAVA_21'),
                            debug: config.get<boolean>('debug', false),
                            quiet: config.get<boolean>('quiet', false),
                            timing: config.get<boolean>('timing', false)
                        };

                        // 3. Run analysis
                        progress.report({ message: `Analyzing ${methodSignature}...` });
                        const result = await analyzeCallHierarchy(
                            context.extensionPath,
                            editor.document.uri,
                            methodSignature,
                            options,
                            'json',
                            wsBoundary,
                            true
                        );

                        if (!result.success || !result.data) {
                            vscode.window.showErrorMessage(`Analysis failed: ${result.error || 'No data returned'}`);
                            return;
                        }

                        // 4. Render and display result
                        progress.report({ message: 'Rendering result...' });
                        const markdown = renderAsMarkdown(result.data, methodSignature, options.depth);
                        
                        // Create a new untitled document with markdown content
                        const doc = await vscode.workspace.openTextDocument({
                            content: markdown,
                            language: 'markdown'
                        });
                        
                        await vscode.window.showTextDocument(doc, {
                            preview: true,
                            viewColumn: vscode.ViewColumn.Active
                        });

                        vscode.window.showInformationMessage(
                            `Call hierarchy analysis complete for ${methodSignature}`
                        );
                    }
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Error: ${message}`);
            }
        }
    );

    // Helper function to build index in background
    async function buildIndexInBackground(projectRoot: string, extensionPath: string) {
        const { spawn } = require('child_process');
        const startTime = Date.now();
        
        outputChannel.appendLine(`[Auto-Index] Building index for: ${projectRoot}`);
        outputChannel.appendLine(`[Auto-Index] Started at: ${new Date().toISOString()}`);
        
        const wsBoundary = getWorkspaceBoundary(projectRoot);
        const multiModuleRoot = findMultiModuleRoot(projectRoot, wsBoundary, true);
        const finalProjectRoot = multiModuleRoot || projectRoot;
        
        // Find all submodules
        let modules = findSubModules(finalProjectRoot);
        
        // 単一モジュールプロジェクトのフォールバック: モジュールが見つからない場合はルートを使用
        if (modules.length === 0) {
            outputChannel.appendLine('[Auto-Index] No submodules found, treating as single module project');
            modules = [finalProjectRoot];
        }
        
        // Find JAR file
        const jarPath = path.join(extensionPath, 'resources', 'java-call-hierarchy-analyzer.jar');
        
        if (!fs.existsSync(jarPath)) {
            outputChannel.appendLine(`[Auto-Index] JAR not found: ${jarPath}`);
            return;
        }
        
        // Get configuration
        const config = vscode.workspace.getConfiguration('javaCallHierarchy');
        const javaPath = config.get<string>('javaPath') || 'java';
        const langLevel = config.get<string>('languageLevel') || 'JAVA_21';
        
        // Build source and class directories for all modules
        const srcDirs: string[] = [];
        const classDirs: string[] = [];
        
        for (const modulePath of modules) {
            // 標準的な src/main/java
            const srcPath = path.join(modulePath, 'src', 'main', 'java');
            if (fs.existsSync(srcPath)) {
                srcDirs.push(path.relative(finalProjectRoot, srcPath));
            }
            
            // Gradle/Maven のクラスディレクトリ
            const gradleClasses = path.join(modulePath, 'build', 'classes', 'java', 'main');
            const mavenClasses = path.join(modulePath, 'target', 'classes');
            
            if (fs.existsSync(gradleClasses)) {
                classDirs.push(path.relative(finalProjectRoot, gradleClasses));
            }
            if (fs.existsSync(mavenClasses)) {
                classDirs.push(path.relative(finalProjectRoot, mavenClasses));
            }
        }
        
        if (srcDirs.length === 0) {
            outputChannel.appendLine('[Auto-Index] No source directories found (src/main/java not found in any module)');
            outputChannel.appendLine('[Auto-Index] Searched modules: ' + modules.join(', '));
            return;
        }
        
        const srcDirsStr = srcDirs.join(',');
        const classDirsStr = classDirs.length > 0 ? classDirs.join(',') : 'build/classes/java/main,target/classes';

        // Resolve dependency classpath via Maven/Gradle for accurate type resolution
        const { classpath: resolvedClasspath, depDirs } = await resolveClasspathForModules(modules, multiModuleRoot, finalProjectRoot);
        
        // Build args array for spawn
        const args = [
            '-jar', jarPath,
            '--build-index',
            '--src', srcDirsStr,
            '--classes', classDirsStr,
            '--workspace', finalProjectRoot,
            '--lang-level', langLevel
        ];

        if (resolvedClasspath) {
            args.push('--cp', resolvedClasspath);
        }
        if (depDirs.length > 0) {
            args.push('--cpdir', depDirs.join(','));
        }
        
        if (config.get('timing')) {
            args.push('--timing');
        }

        // Auto-add --timing when performance logging is enabled
        const perfEnabled = vscode.workspace.getConfiguration('callcanvas').get<boolean>('performanceLog', false);
        if (perfEnabled && !args.includes('--timing')) {
            args.push('--timing');
        }

        outputChannel.appendLine('[Auto-Index] Command: ' + javaPath + ' ' + args.join(' '));

        // Use spawn for streaming output (no buffer limit)
        const child = spawn(javaPath, args, { cwd: finalProjectRoot });

        let stderrBuf = '';

        child.stdout.on('data', (data: Buffer) => {
            const lines = data.toString().split('\n');
            lines.forEach((line: string) => {
                if (line.trim()) {
                    outputChannel.appendLine('[Auto-Index] ' + line);
                }
            });
        });

        child.stderr.on('data', (data: Buffer) => {
            const chunk = data.toString();
            stderrBuf += chunk;
            const lines = chunk.split('\n');
            lines.forEach((line: string) => {
                if (line.trim()) {
                    outputChannel.appendLine('[Auto-Index] ' + line);
                }
            });
        });

        child.on('error', (error: Error) => {
            const elapsed = Date.now() - startTime;
            outputChannel.appendLine('[Auto-Index] Error: ' + error.message);
            outputChannel.appendLine('[Auto-Index] Failed after ' + elapsed + 'ms');
            vscode.window.showWarningMessage('Background index build failed. See output for details.');
        });

        child.on('close', (code: number) => {
            const elapsed = Date.now() - startTime;

            if (perfEnabled) {
                const perfCh = vscode.window.createOutputChannel('CallCanvas Performance');
                perfCh.appendLine('=== buildCallIndex (auto) ===');
                for (const line of stderrBuf.split('\n')) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('[TIMING]')) {
                        perfCh.appendLine('[PERF-JAVA] ' + trimmed.substring('[TIMING]'.length).trim());
                    }
                }
                perfCh.appendLine(`[PERF] ${new Date().toISOString()} | buildCallIndex | TOTAL=${elapsed}ms | detail=exitCode:${code ?? -1}`);
            }

            if (code !== 0) {
                outputChannel.appendLine('[Auto-Index] Process exited with code ' + code);
                outputChannel.appendLine('[Auto-Index] Failed after ' + elapsed + 'ms');
                vscode.window.showWarningMessage('Background index build failed. See output for details.');
            } else {
                outputChannel.appendLine('[Auto-Index] Index built successfully in ' + elapsed + 'ms');
                vscode.window.showInformationMessage('Call index built successfully! Next analysis will be faster.');
            }
        });
    }

    /**
     * Resolve method signature from call index by file path and line number
     */
    async function resolveFromIndex(
        filePath: string,
        lineNumber: number,
        projectRoot: string
    ): Promise<string | null> {
        const config = vscode.workspace.getConfiguration('javaCallHierarchy');
        // Use 'java' as default if javaPath is empty or not set
        const javaPath = config.get<string>('javaPath') || 'java';
        const jarPath = path.join(__dirname, '..', 'resources', 'java-call-hierarchy-analyzer.jar');
        
        const args = [
            '-jar', jarPath,
            '--resolve-from-index', `${filePath}:${lineNumber}`,
            '--workspace', projectRoot
        ];
        
        return new Promise((resolve) => {
            const { spawn } = require('child_process');
            const child = spawn(javaPath, args, { cwd: projectRoot });
            
            let stdout = '';
            let stderr = '';
            
            child.stdout.on('data', (data: Buffer) => {
                stdout += data.toString();
            });
            
            child.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
            });
            
            child.on('error', (error: Error) => {
                outputChannel.appendLine('[resolve-from-index] Error: ' + error.message);
                resolve(null);
            });
            
            child.on('close', (code: number) => {
                if (code === 0 && stdout.trim()) {
                    const signature = stdout.trim();
                    outputChannel.appendLine('[resolve-from-index] Resolved: ' + signature);
                    resolve(signature);
                } else {
                    if (stderr) {
                        outputChannel.appendLine('[resolve-from-index] Failed: ' + stderr);
                        if (stderr.includes('No method found at')) {
                            outputChannel.appendLine('[resolve-from-index] Hint: This line has no method (e.g. annotation or class line). Place cursor on a method name (e.g. getAll, create) or use class-level export from the class declaration line.');
                        }
                    }
                    resolve(null);
                }
            });
        });
    }

    // Common function for exporting CallCanvas JSON with specified depth
    async function exportCallCanvasWithDepth(depth: number): Promise<string | undefined> {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor');
                return undefined;
            }

            if (editor.document.languageId !== 'java') {
                vscode.window.showErrorMessage('This command only works with Java files');
                return undefined;
            }

            try {
                return await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                    title: `Exporting call hierarchy (depth=${depth})...`,
                        cancellable: false
                    },
                    async (progress) => {
                        // 1. Get project root first
                        const currentFilePath = editor.document.uri.fsPath;
                        let projectRoot = path.dirname(currentFilePath);
                        
                        // Search upwards for pom.xml or build.gradle
                        while (projectRoot && projectRoot !== path.dirname(projectRoot)) {
                            const hasPom = fs.existsSync(path.join(projectRoot, 'pom.xml'));
                            const hasGradle = fs.existsSync(path.join(projectRoot, 'build.gradle')) || 
                                             fs.existsSync(path.join(projectRoot, 'build.gradle.kts'));
                            
                            if (hasPom || hasGradle) {
                                break;
                            }
                            
                            projectRoot = path.dirname(projectRoot);
                        }
                        
                        const wsBoundary = getWorkspaceBoundary(projectRoot);
                        const multiModuleRoot = findMultiModuleRoot(projectRoot, wsBoundary, true);
                        const finalProjectRoot = multiModuleRoot || projectRoot;
                        const allowImplicitExport = true;
                        
                        // 1.5. Resolve method signature (Index逆引き優先、フォールバック対応)
                        progress.report({ message: 'Resolving method...' });
                        let methodSignature: string | null = null;
                        
                        // まずIndex逆引きを試行
                        if (indexExists(finalProjectRoot)) {
                            const lineNumber = editor.selection.active.line + 1;
                            methodSignature = await resolveFromIndex(currentFilePath, lineNumber, finalProjectRoot);
                            if (methodSignature) {
                                outputChannel.appendLine('[Method Resolution] Resolved from index: ' + methodSignature);
                            }
                        }
                        
                        // Index逆引きが失敗した場合は従来のmethodResolverにフォールバック
                        if (!methodSignature) {
                            outputChannel.appendLine('[Method Resolution] Index not available or resolution failed, falling back to methodResolver');
                            methodSignature = await resolveMethodAtCursor(editor);
                        }
                        
                        if (!methodSignature) {
                            const classFqnExport = await resolveClassAtCursor(editor);
                            const hintExport = classFqnExport
                                ? 'For class-level export, use "Export Call Hierarchy as CallCanvas JSON (Class)" with cursor on the class declaration line.'
                                : 'Place cursor on a method name or on the class declaration line for class-level export.';
                            vscode.window.showErrorMessage(
                                'Could not resolve method at cursor position. ' + hintExport
                            );
                            return undefined;
                        }
                        
                        // 1.6. Check if index exists and build in background if not
                        if (!indexExists(finalProjectRoot)) {
                            outputChannel.appendLine(`[Auto-Index] Index not found for: ${finalProjectRoot}`);
                            vscode.window.showInformationMessage(
                                'Building call index in background... First analysis may be slow, but future analyses will be faster.'
                            );
                            buildIndexInBackground(finalProjectRoot, context.extensionPath);
                        }

                    // 2. Get configuration (resource-scoped so folder .vscode/settings.json is used)
                        const config = vscode.workspace.getConfiguration('javaCallHierarchy', editor.document.uri);
                        const callcanvasConfig = vscode.workspace.getConfiguration('callcanvas', editor.document.uri);
                        const options = {
                        depth: depth,
                            excludePatterns: config.get<string>('excludePatterns', ''),
                            javaPath: config.get<string>('javaPath', ''),
                            languageLevel: config.get<string>('languageLevel', 'JAVA_21'),
                            debug: config.get<boolean>('debug', false),
                            quiet: config.get<boolean>('quiet', false),
                            timing: config.get<boolean>('timing', false),
                            windowWidth: callcanvasConfig.get<number>('windowWidth', 600)
                        };
                        if (options.debug) outputChannel.show(true);

                        // 3. Run analysis with callcanvas format
                        outputChannel.appendLine('[Export CallCanvas] Starting analysis...');
                        outputChannel.appendLine('[Export CallCanvas]   File: ' + currentFilePath);
                        outputChannel.appendLine('[Export CallCanvas]   Method: ' + methodSignature);
                        outputChannel.appendLine('[Export CallCanvas]   Project root: ' + finalProjectRoot);
                        outputChannel.appendLine('[Export CallCanvas]   Depth: ' + depth);
                        
                    progress.report({ message: `Analyzing ${methodSignature} (depth=${depth})...` });
                        const result = await analyzeCallHierarchy(
                            context.extensionPath,
                            editor.document.uri,
                            methodSignature,
                            options,
                            'callcanvas',
                            wsBoundary,
                            allowImplicitExport
                        );

                        if (!result.success) {
                            vscode.window.showErrorMessage(`Analysis failed: ${result.error || 'Unknown error'}`);
                            return undefined;
                        }

                        if (!result.callcanvasJsonPath || result.callcanvasJsonPath.trim() === '') {
                            outputChannel.appendLine('[Export CallCanvas] ERROR: callcanvasJsonPath is empty or undefined');
                            outputChannel.appendLine('[Export CallCanvas]   result.success: ' + result.success);
                            outputChannel.appendLine('[Export CallCanvas]   result.callcanvasJsonPath: "' + result.callcanvasJsonPath + '"');
                            vscode.window.showErrorMessage('CallCanvas JSON was not generated');
                            return undefined;
                        }

                        // Validate the path exists before trying to open it
                        if (!fs.existsSync(result.callcanvasJsonPath)) {
                            outputChannel.appendLine('[Export CallCanvas] ERROR: callcanvas.json file not found at: ' + result.callcanvasJsonPath);
                            vscode.window.showErrorMessage('CallCanvas JSON file not found: ' + result.callcanvasJsonPath);
                            return undefined;
                        }

                        outputChannel.appendLine('[Export CallCanvas] Generated callcanvas.json: ' + result.callcanvasJsonPath);

                        // Return the path instead of opening it (caller decides what to do)
                        return result.callcanvasJsonPath;
                    }
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const stack = error instanceof Error ? error.stack : '';
                outputChannel.appendLine('[Export CallCanvas] EXCEPTION: ' + message);
                if (stack) {
                    outputChannel.appendLine('[Export CallCanvas] Stack trace:');
                    for (const line of stack.split('\n')) {
                        outputChannel.appendLine('  ' + line);
                    }
                }
                outputChannel.show(true);
                vscode.window.showErrorMessage(`Error: ${message}`);
                return undefined;
            }
        }

    // Command: Export as CallCanvas JSON (uses config depth - for backward compatibility)
    const exportCallCanvasCommand = vscode.commands.registerCommand(
        'javaCallHierarchy.exportCallCanvas',
        async () => {
            const config = vscode.workspace.getConfiguration('javaCallHierarchy');
            const depth = config.get<number>('depth', 5);
            const jsonPath = await exportCallCanvasWithDepth(depth);
            
            // If export succeeded, open the JSON file in the editor
            if (jsonPath) {
                const callcanvasUri = vscode.Uri.file(jsonPath);
                const doc = await vscode.workspace.openTextDocument(callcanvasUri);
                await vscode.window.showTextDocument(doc, {
                    preview: true,
                    viewColumn: vscode.ViewColumn.Active
                });
                vscode.window.showInformationMessage(`CallCanvas JSON exported: ${jsonPath}`);
            }
        }
    );

    // Command: Export Call Hierarchy as CallCanvas JSON (Class) - all methods in the class as roots
    const exportCallCanvasClassCommand = vscode.commands.registerCommand(
        'javaCallHierarchy.exportCallCanvasClass',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor');
                return;
            }
            if (editor.document.languageId !== 'java') {
                vscode.window.showErrorMessage('This command only works with Java files');
                return;
            }
            const currentFilePath = editor.document.uri.fsPath;
            let projectRoot = path.dirname(currentFilePath);
            while (projectRoot && projectRoot !== path.dirname(projectRoot)) {
                const hasPom = fs.existsSync(path.join(projectRoot, 'pom.xml'));
                const hasGradle = fs.existsSync(path.join(projectRoot, 'build.gradle')) ||
                    fs.existsSync(path.join(projectRoot, 'build.gradle.kts'));
                if (hasPom || hasGradle) break;
                projectRoot = path.dirname(projectRoot);
            }
            const wsBoundaryClass = getWorkspaceBoundary(projectRoot);
            const allowImplicitClass = true;
            const multiModuleRoot = findMultiModuleRoot(projectRoot, wsBoundaryClass, allowImplicitClass);
            const finalProjectRoot = multiModuleRoot || projectRoot;
            if (!indexExists(finalProjectRoot)) {
                vscode.window.showInformationMessage(
                    'Building call index in background... Class-level analysis requires the index. If analysis fails, wait for the build to finish and try again.'
                );
                buildIndexInBackground(finalProjectRoot, context.extensionPath);
            }
            const classFqn = await resolveClassAtCursor(editor);
            if (!classFqn) {
                vscode.window.showErrorMessage('Place the cursor on the class declaration line (the line containing "class", "interface", or "enum" and the type name).');
                return;
            }
            const depthChoice = await vscode.window.showQuickPick(
                [
                    { label: 'Depth 1', depth: 1 },
                    { label: 'Depth 3', depth: 3 },
                    { label: 'Depth 5', depth: 5 }
                ],
                { placeHolder: 'Select analysis depth (each root is analyzed to this depth)' }
            );
            const depth = depthChoice?.depth ?? vscode.workspace.getConfiguration('javaCallHierarchy').get<number>('depth', 5);
            try {
                const jsonPath = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Exporting call hierarchy (class, depth=${depth})...`,
                        cancellable: false
                    },
                    async (progress) => {
                        const options = buildClassAnalyzerOptions(depth);
                        progress.report({ message: `Analyzing class ${classFqn} (depth=${depth})...` });
                        const result = await analyzeCallHierarchyForClass(
                            context.extensionPath,
                            editor.document.uri,
                            classFqn,
                            options,
                            'callcanvas',
                            wsBoundaryClass,
                            allowImplicitClass
                        );
                        if (!result.success) {
                            const err = result.error || 'Unknown error';
                            if (err.includes('インデックスが未構築') || err.includes('Build Call Index')) {
                                throw new Error('Index is not ready yet. Please wait for "Build Call Index" to finish, then run this command again.');
                            }
                            throw new Error(err);
                        }
                        if (!result.callcanvasJsonPath || !fs.existsSync(result.callcanvasJsonPath)) {
                            throw new Error('CallCanvas JSON was not generated.');
                        }
                        return result.callcanvasJsonPath;
                    }
                );
                if (jsonPath) {
                    const callcanvasUri = vscode.Uri.file(jsonPath);
                    const doc = await vscode.workspace.openTextDocument(callcanvasUri);
                    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active });
                    vscode.window.showInformationMessage(`CallCanvas JSON (class) exported: ${jsonPath}`);
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(message);
            }
        }
    );

    // Command: Open CallCanvas Viewer with File (export and open viewer in one step)
    const openCallCanvasViewerCommand = vscode.commands.registerCommand(
        'javaCallHierarchy.openCallCanvasViewer',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor');
                return;
            }
            if (editor.document.languageId !== 'java') {
                vscode.window.showErrorMessage('This command only works with Java files');
                return;
            }

            const currentFilePath = editor.document.uri.fsPath;
            const lineNumber = editor.selection.active.line + 1;

            // Same project root logic as exportCallCanvasWithDepth
            let projectRoot = path.dirname(currentFilePath);
            while (projectRoot && projectRoot !== path.dirname(projectRoot)) {
                const hasPom = fs.existsSync(path.join(projectRoot, 'pom.xml'));
                const hasGradle = fs.existsSync(path.join(projectRoot, 'build.gradle')) ||
                    fs.existsSync(path.join(projectRoot, 'build.gradle.kts'));
                if (hasPom || hasGradle) {
                    break;
                }
                projectRoot = path.dirname(projectRoot);
            }
            const wsBoundaryMethod = getWorkspaceBoundary(projectRoot);
            const allowImplicitMethod = true;
            const multiModuleRoot = findMultiModuleRoot(projectRoot, wsBoundaryMethod, allowImplicitMethod);
            const finalProjectRoot = multiModuleRoot || projectRoot;

            // Resolve method signature (same as export)
            outputChannel.appendLine(`[OpenViewer] file=${currentFilePath} line=${lineNumber} projectRoot=${finalProjectRoot}`);
            let methodSignature: string | null = null;
            if (indexExists(finalProjectRoot)) {
                methodSignature = await resolveFromIndex(currentFilePath, lineNumber, finalProjectRoot);
            }
            outputChannel.appendLine(`[OpenViewer] resolveFromIndex => ${methodSignature || '(null)'}`);
            if (!methodSignature) {
                methodSignature = await resolveMethodAtCursor(editor);
                outputChannel.appendLine(`[OpenViewer] resolveMethodAtCursor => ${methodSignature || '(null)'}`);
            }
            if (!methodSignature) {
                // Fallback: try to resolve as class (current line or next few lines, e.g. cursor on @RequestMapping above class)
                const classFqn = await resolveClassAtCursorOrNextLines(editor);
                outputChannel.appendLine(`[OpenViewer] resolveClassAtCursorOrNextLines => ${classFqn || '(null)'}`);
                if (classFqn) {
                    outputChannel.appendLine(`[OpenViewer] Class-level flow for: ${classFqn}`);
                    if (!indexExists(finalProjectRoot)) {
                        outputChannel.appendLine(`[OpenViewer] Index not found at ${finalProjectRoot}, building in background`);
                        vscode.window.showInformationMessage(
                            'Building call index in background... Class-level analysis requires the index. If analysis fails, wait for the build to finish and try again.'
                        );
                        buildIndexInBackground(finalProjectRoot, context.extensionPath);
                    }
                    const projectRootForCallCanvasClass = findProjectRootForCallCanvas(currentFilePath);
                    if (projectRootForCallCanvasClass) {
                        const expectedClassPath = getExpectedClassCallCanvasPath(projectRootForCallCanvasClass, classFqn);
                        const cacheExists = fs.existsSync(expectedClassPath);
                        const cacheValid = cacheExists && isCallCanvasCacheValid(expectedClassPath, finalProjectRoot);
                        outputChannel.appendLine(`[OpenViewer] Checking cached JSON: ${expectedClassPath} => exists=${cacheExists} valid=${cacheValid}`);
                        if (cacheValid) {
                            await vscode.commands.executeCommand('callcanvas.openViewerWithFile', vscode.Uri.file(expectedClassPath));
                            return;
                        }
                        if (cacheExists && !cacheValid) {
                            outputChannel.appendLine(`[OpenViewer] Stale cache detected (filePaths don't resolve under project root), re-analyzing...`);
                        }
                    }
                    outputChannel.appendLine(`[OpenViewer] Running class-level analysis...`);
                    try {
                        const classJsonPath = await vscode.window.withProgress(
                            {
                                location: vscode.ProgressLocation.Notification,
                                title: `Exporting call hierarchy for class ${classFqn}...`,
                                cancellable: false
                            },
                            async (progress) => {
                                const options = buildClassAnalyzerOptions(
                                    vscode.workspace.getConfiguration('javaCallHierarchy').get<number>('depth', 5)
                                );
                                progress.report({ message: `Analyzing class ${classFqn}...` });
                                const result = await analyzeCallHierarchyForClass(
                                    context.extensionPath,
                                    editor.document.uri,
                                    classFqn,
                                    options,
                                    'callcanvas',
                                    wsBoundaryMethod,
                                    allowImplicitMethod
                                );
                                if (!result.success) {
                                    const err = result.error || 'Unknown error';
                                    outputChannel.appendLine(`[OpenViewer] Class analysis failed: ${err}`);
                                    if (err.includes('インデックスが未構築') || err.includes('Build Call Index')) {
                                        throw new Error('Index is not ready yet. Please wait for "Build Call Index" to finish, then try again.');
                                    }
                                    throw new Error(err);
                                }
                                outputChannel.appendLine(`[OpenViewer] Class analysis succeeded: ${result.callcanvasJsonPath}`);
                                if (!result.callcanvasJsonPath || !fs.existsSync(result.callcanvasJsonPath)) {
                                    throw new Error('CallCanvas JSON was not generated.');
                                }
                                return result.callcanvasJsonPath;
                            }
                        );
                        if (classJsonPath) {
                            outputChannel.appendLine(`[OpenViewer] Opening viewer: ${classJsonPath}`);
                            await vscode.commands.executeCommand('callcanvas.openViewerWithFile', vscode.Uri.file(classJsonPath));
                        }
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        outputChannel.appendLine(`[OpenViewer] Error: ${message}`);
                        vscode.window.showErrorMessage(message);
                    }
                    return;
                }
                // Neither a method nor a class declaration
                vscode.window.showErrorMessage(
                    'Could not resolve method or class at cursor position. '
                    + 'Place cursor on a method definition or on the class declaration line (the line containing "class", "interface", or "enum" and the type name).'
                );
                return;
            }

            // Use cached callcanvas JSON if valid, otherwise re-analyze
            const projectRootForCallCanvas = findProjectRootForCallCanvas(currentFilePath);
            if (projectRootForCallCanvas) {
                const expectedPath = getExpectedCallCanvasPath(projectRootForCallCanvas, methodSignature);
                const cacheExists = fs.existsSync(expectedPath);
                const cacheValid = cacheExists && isCallCanvasCacheValid(expectedPath, finalProjectRoot);
                if (cacheValid) {
                    await vscode.commands.executeCommand('callcanvas.openViewerWithFile', vscode.Uri.file(expectedPath));
                    return;
                }
                if (cacheExists && !cacheValid) {
                    outputChannel.appendLine(`[OpenViewer] Stale method cache detected, re-analyzing...`);
                }
            }
            const config = vscode.workspace.getConfiguration('javaCallHierarchy');
            const depth = config.get<number>('depth', 5);
            const jsonPath = await exportCallCanvasWithDepth(depth);
            if (jsonPath) {
                await vscode.commands.executeCommand('callcanvas.openViewerWithFile', vscode.Uri.file(jsonPath));
            }
        }
    );


    // API Command: Resolve method signature from file path and line number
    // This is used by CallCanvas Viewer to get accurate method signatures
    const resolveMethodSignatureCommand = vscode.commands.registerCommand(
        'javaCallHierarchy.resolveMethodSignature',
        async (filePath: string, lineNumber: number): Promise<string | null> => {
            try {
                let uri: vscode.Uri;
                
                // If it's already a URI, parse it
                if (filePath.includes('://')) {
                    uri = vscode.Uri.parse(filePath);
                } 
                // If it's a relative path, search for it in the workspace
                else if (!path.isAbsolute(filePath)) {
                    // Search for the file in the workspace using glob pattern
                    const files = await vscode.workspace.findFiles(`**/${filePath}`, null, 1);
                    if (files.length === 0) {
                        // If not found with full path, try searching by filename only
                        const fileName = path.basename(filePath);
                        const filesWithSameName = await vscode.workspace.findFiles(`**/${fileName}`, null, 10);
                        
                        // Filter by matching the relative path structure
                        const matchingFiles = filesWithSameName.filter(fileUri => 
                            fileUri.fsPath.endsWith(filePath.replace(/\//g, path.sep))
                        );
                        
                        if (matchingFiles.length > 0) {
                            uri = matchingFiles[0];
                        } else {
                            throw new Error(`File not found in workspace: ${filePath}`);
                        }
                    } else {
                        uri = files[0];
                    }
                }
                // If it's an absolute path, convert it to workspace-relative if possible
                else {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && workspaceFolders.length > 0) {
                        const workspaceRoot = workspaceFolders[0].uri.fsPath;
                        if (filePath.startsWith(workspaceRoot)) {
                            const relativePath = filePath.substring(workspaceRoot.length + 1);
                            uri = vscode.Uri.joinPath(workspaceFolders[0].uri, relativePath);
                        } else {
                            uri = vscode.Uri.file(filePath);
                        }
                    } else {
                        uri = vscode.Uri.file(filePath);
                    }
                }
                
                const document = await vscode.workspace.openTextDocument(uri);
                
                // Create a temporary editor-like object for the resolver
                const position = new vscode.Position(lineNumber - 1, 0); // Convert to 0-based
                
                // Find the method at this line by scanning the document
                const text = document.getText();
                const lines = text.split('\n');
                
                // Import and use the method resolver
                const { resolveMethodFromDocument } = await import('./methodResolver');
                const signature = await resolveMethodFromDocument(document, lineNumber);
                
                outputChannel.appendLine(`[API] resolveMethodSignature: ${filePath}:${lineNumber} -> ${signature || 'null'}`);
                return signature;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                outputChannel.appendLine(`[API] resolveMethodSignature error: ${message}`);
                return null;
            }
        }
    );

    // API Command: Analyze method and return CallCanvas JSON data (no UI)
    // This is used by CallCanvas Viewer for "analyze next level" feature
    const analyzeMethodCommand = vscode.commands.registerCommand(
        'javaCallHierarchy.analyzeMethod',
        async (params: {
            filePath: string;
            methodSignature?: string;
            /** Class-level root (all methods of the class). Mutually exclusive with methodSignature. */
            rootClass?: string;
            depth?: number;
            direction?: 'outgoing' | 'incoming';
        }): Promise<{ success: boolean; data?: any; error?: string }> => {
            try {
                const config = vscode.workspace.getConfiguration('javaCallHierarchy');
                const analysisDepth =
                    params.depth ?? config.get<number>('depth', 5);
                if (!params.methodSignature && !params.rootClass) {
                    return { success: false, error: 'methodSignature or rootClass is required' };
                }
                outputChannel.appendLine(`[API] analyzeMethod: ${params.rootClass || params.methodSignature} (depth=${analysisDepth}, direction=${params.direction || 'outgoing'}, classLevel=${!!params.rootClass})`);

                const callcanvasConfig = vscode.workspace.getConfiguration('callcanvas');
                const options = {
                    depth: analysisDepth,
                    excludePatterns: config.get<string>('excludePatterns', ''),
                    javaPath: config.get<string>('javaPath', ''),
                    languageLevel: config.get<string>('languageLevel', 'JAVA_21'),
                    debug: config.get<boolean>('debug', false),
                    quiet: config.get<boolean>('quiet', false),
                    timing: config.get<boolean>('timing', false),
                    windowWidth: callcanvasConfig.get<number>('windowWidth', 600),
                    direction: params.direction
                };

                const uri = vscode.Uri.file(params.filePath);
                const apiBoundary = getWorkspaceBoundary(params.filePath);
                const result = params.rootClass
                    ? await analyzeCallHierarchyForClass(
                        context.extensionPath,
                        uri,
                        params.rootClass,
                        options,
                        'callcanvas',
                        apiBoundary,
                        true
                    )
                    : await analyzeCallHierarchy(
                        context.extensionPath,
                        uri,
                        params.methodSignature as string,
                        options,
                        'callcanvas',
                        apiBoundary,
                        true
                    );

                if (result.success && result.callcanvasJsonPath) {
                    // Read the generated callcanvas.json
                    const fs = await import('fs');
                    const callcanvasContent = fs.readFileSync(result.callcanvasJsonPath, 'utf8');
                    const callcanvasData = JSON.parse(callcanvasContent);

                    // The CLI exits 0 with an empty graph when the root cannot be
                    // resolved. Report that as a failure so callers do not replace a
                    // working canvas with nothing.
                    const windowCount = callcanvasData.windows?.length || 0;
                    if (windowCount === 0) {
                        const target = params.rootClass || params.methodSignature;
                        outputChannel.appendLine(`[API] analyzeMethod produced no windows for: ${target}`);
                        return { success: false, error: `Root not resolved in the analyzed sources: ${target}` };
                    }

                    outputChannel.appendLine(`[API] analyzeMethod success: ${windowCount} windows`);
                    return { success: true, data: callcanvasData };
                } else {
                    outputChannel.appendLine(`[API] analyzeMethod failed: ${result.error}`);
                    return { success: false, error: result.error };
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                outputChannel.appendLine(`[API] analyzeMethod error: ${message}`);
                return { success: false, error: message };
            }
        }
    );

    // Command: Build Call Index
    const buildIndexCommand = vscode.commands.registerCommand(
        'javaCallHierarchy.buildIndex',
        async () => {
            let projectRoot: string | undefined;
            
            // 1. Try to get project root from currently open Java file
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'java') {
                const currentFilePath = editor.document.uri.fsPath;
                const foundRoot = findProjectRootFromFile(currentFilePath);
                if (foundRoot) {
                    projectRoot = foundRoot;
                    outputChannel.appendLine(`Detected project root from open file: ${projectRoot}`);
                }
            }
            
            // 2. If no project root found from file, scan workspace
            if (!projectRoot) {
                const projects = findJavaProjectsInWorkspace();
                
                if (projects.length === 0) {
                    vscode.window.showErrorMessage(
                        'Javaプロジェクトが見つかりません。ワークスペースにpom.xmlまたはbuild.gradleを含むプロジェクトがあることを確認してください。'
                    );
                    return;
                }
                
                if (projects.length === 1) {
                    // Auto-select if only one project found
                    projectRoot = projects[0].path;
                    outputChannel.appendLine(`Auto-selected project: ${projects[0].name} (${projectRoot})`);
                } else {
                    // Show QuickPick if multiple projects found
                    const selected = await vscode.window.showQuickPick(
                        projects.map(p => ({
                            label: p.name,
                            description: p.path,
                            path: p.path
                        })),
                        { 
                            placeHolder: 'インデックスを構築するプロジェクトを選択してください',
                            title: 'Build Call Index'
                        }
                    );
                    
                    if (!selected) {
                        // User cancelled
                        return;
                    }
                    
                    projectRoot = selected.path;
                    outputChannel.appendLine(`User selected project: ${selected.label} (${projectRoot})`);
                }
            }

            try {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'Building call index...',
                        cancellable: false
                    },
                    async (progress) => {
                        progress.report({ message: 'This may take several minutes...' });
                        
                        const startTime = Date.now();
                        
                        // At this point, projectRoot must be defined
                        const finalProjectRoot = projectRoot!;
                        
                        const wsBoundaryIdx = getWorkspaceBoundary(finalProjectRoot);
                        const multiModuleRoot = findMultiModuleRoot(finalProjectRoot, wsBoundaryIdx, true);
                        const effectiveProjectRoot = (multiModuleRoot && multiModuleRoot !== finalProjectRoot) 
                            ? multiModuleRoot 
                            : finalProjectRoot;
                        
                        if (multiModuleRoot && multiModuleRoot !== finalProjectRoot) {
                            outputChannel.appendLine(`Detected multi-module root: ${multiModuleRoot}`);
                        }
                        
                        // Find all submodules
                        const modules = findSubModules(effectiveProjectRoot);
                        outputChannel.appendLine(`Found ${modules.length} module(s): ${modules.join(', ')}`);
                        
                        // Find JAR file
                        const extensionPath = context.extensionPath;
                        const jarPath = path.join(extensionPath, 'resources', 'java-call-hierarchy-analyzer.jar');
                        
                        if (!fs.existsSync(jarPath)) {
                            vscode.window.showErrorMessage('Analyzer JAR not found: ' + jarPath);
                            return;
                        }
                        
                        // Get configuration
                        const config = vscode.workspace.getConfiguration('javaCallHierarchy');
                        const javaPath = config.get<string>('javaPath') || 'java';
                        const langLevel = config.get<string>('languageLevel') || 'JAVA_21';
                        
                        // Build source and class directories for all modules
                        const srcDirs: string[] = [];
                        const classDirs: string[] = [];
                        
                        for (const modulePath of modules) {
                            // Source directories
                            const srcPath = path.join(modulePath, 'src', 'main', 'java');
                            if (fs.existsSync(srcPath)) {
                                srcDirs.push(path.relative(effectiveProjectRoot, srcPath));
                            }
                            
                            // Class directories (both Gradle and Maven)
                            const gradleClasses = path.join(modulePath, 'build', 'classes', 'java', 'main');
                            const mavenClasses = path.join(modulePath, 'target', 'classes');
                            
                            if (fs.existsSync(gradleClasses)) {
                                classDirs.push(path.relative(effectiveProjectRoot, gradleClasses));
                            }
                            if (fs.existsSync(mavenClasses)) {
                                classDirs.push(path.relative(effectiveProjectRoot, mavenClasses));
                            }
                        }
                        
                        if (srcDirs.length === 0) {
                            vscode.window.showErrorMessage('No source directories found in project');
                            return;
                        }
                        
                        const srcDirsStr = srcDirs.join(',');
                        const classDirsStr = classDirs.length > 0 ? classDirs.join(',') : 'build/classes/java/main,target/classes';

                        // Resolve dependency classpath via Maven/Gradle for accurate type resolution
                        const { classpath: resolvedClasspath, depDirs } = await resolveClasspathForModules(modules, multiModuleRoot, effectiveProjectRoot);
                        
                        outputChannel.appendLine(`Project root: ${effectiveProjectRoot}`);
                        outputChannel.appendLine(`Source directories: ${srcDirsStr}`);
                        outputChannel.appendLine(`Class directories: ${classDirsStr}`);
                        if (resolvedClasspath) {
                            const count = resolvedClasspath.split(',').filter(Boolean).length;
                            outputChannel.appendLine(`Resolved classpath: ${count} JARs from build tool`);
                        }
                        
                        // Build args array for spawn
                        const args = [
                            '-jar', jarPath,
                            '--build-index',
                            '--src', srcDirsStr,
                            '--classes', classDirsStr,
                            '--workspace', effectiveProjectRoot,
                            '--lang-level', langLevel
                        ];

                        if (resolvedClasspath) {
                            args.push('--cp', resolvedClasspath);
                        }
                        if (depDirs.length > 0) {
                            args.push('--cpdir', depDirs.join(','));
                        }
                        
                        if (config.get('timing')) {
                            args.push('--timing');
                        }

                        if (config.get('debug')) {
                            args.push('--debug');
                        }

                        if (config.get('quiet')) {
                            args.push('--quiet');
                        }

                        // Auto-add --timing when performance logging is enabled
                        const perfEnabled = vscode.workspace.getConfiguration('callcanvas').get<boolean>('performanceLog', false);
                        if (perfEnabled && !args.includes('--timing')) {
                            args.push('--timing');
                        }

                        outputChannel.appendLine('Building call index...');
                        outputChannel.appendLine('Command: ' + javaPath + ' ' + args.join(' '));

                        return new Promise<void>((resolve, reject) => {
                            const { spawn } = require('child_process');
                            const child = spawn(javaPath, args, { cwd: effectiveProjectRoot });

                            let stderrBuf = '';

                            child.stdout.on('data', (data: Buffer) => {
                                const lines = data.toString().split('\n');
                                lines.forEach((line: string) => {
                                    if (line.trim()) {
                                        outputChannel.appendLine(line);
                                    }
                                });
                            });

                            child.stderr.on('data', (data: Buffer) => {
                                const chunk = data.toString();
                                stderrBuf += chunk;
                                const lines = chunk.split('\n');
                                lines.forEach((line: string) => {
                                    if (line.trim()) {
                                        outputChannel.appendLine(line);
                                    }
                                });
                            });

                            child.on('error', (error: Error) => {
                                const elapsed = Date.now() - startTime;
                                outputChannel.appendLine('Error: ' + error.message);
                                outputChannel.appendLine('Failed after ' + elapsed + 'ms');
                                outputChannel.show(true);
                                vscode.window.showErrorMessage('Failed to build call index. Check output for details.');
                                reject(error);
                            });

                            child.on('close', (code: number) => {
                                const elapsed = Date.now() - startTime;

                                if (perfEnabled) {
                                    const perfCh = vscode.window.createOutputChannel('CallCanvas Performance');
                                    perfCh.appendLine('=== buildCallIndex (manual) ===');
                                    for (const line of stderrBuf.split('\n')) {
                                        const trimmed = line.trim();
                                        if (trimmed.startsWith('[TIMING]')) {
                                            perfCh.appendLine('[PERF-JAVA] ' + trimmed.substring('[TIMING]'.length).trim());
                                        }
                                    }
                                    perfCh.appendLine(`[PERF] ${new Date().toISOString()} | buildCallIndex | TOTAL=${elapsed}ms | detail=exitCode:${code ?? -1}`);
                                }

                                if (code !== 0) {
                                    outputChannel.appendLine('Process exited with code ' + code);
                                    outputChannel.appendLine('Failed after ' + elapsed + 'ms');
                                    outputChannel.show(true);
                                    vscode.window.showErrorMessage('Failed to build call index. Check output for details.');
                                    reject(new Error(`Process exited with code ${code}`));
                                } else {
                                    outputChannel.appendLine('Index built successfully in ' + elapsed + 'ms');
                                    vscode.window.showInformationMessage('Call index built successfully!');
                                    resolve();
                                }
                            });
                        });
                    }
                );
            } catch (error: any) {
                vscode.window.showErrorMessage('Error building call index: ' + error.message);
                outputChannel.appendLine('Error: ' + error.message);
            }
        }
    );

    context.subscriptions.push(
        analyzeCommand,
        exportCallCanvasCommand,
        exportCallCanvasClassCommand,
        openCallCanvasViewerCommand,
        resolveMethodSignatureCommand,
        analyzeMethodCommand,
        buildIndexCommand
    );
}

export function deactivate() {
    // Cleanup if needed
}

