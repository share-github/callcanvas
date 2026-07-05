import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { log, logError } from './logger';
import { extractMethodSignature } from './methodExtractor';
import { findMultiModuleRoot, findSubModules, findAnalyzerJar, findJavaPath } from './projectDetector';
import { isPerfLogEnabled, perfLog, perfTotal, emitJavaTimingLines } from './perfLogger';

/**
 * CLI writes callcanvas_<Class>_<method>.json (or callcanvas_<Class>.json) and logs [CALLCANVAS_FILE]... on stderr.
 * Next-level analysis used to only read callcanvas.json — resolve the actual path the same way as incoming.
 */
function resolveCallCanvasCliOutputPath(tempDir: string, stderr: string): string | null {
    const marker = '[CALLCANVAS_FILE]';
    for (const line of stderr.split('\n')) {
        if (line.includes(marker)) {
            const candidate = line.substring(line.indexOf(marker) + marker.length).trim();
            if (fs.existsSync(candidate)) {
                log(`Output file from marker: ${candidate}`);
                return candidate;
            }
        }
    }
    try {
        const files = fs
            .readdirSync(tempDir)
            .filter(f => f.startsWith('callcanvas_') && f.endsWith('.json'))
            .map(f => path.join(tempDir, f));
        if (files.length > 0) {
            log(`Output file from scan: ${files[0]}`);
            return files[0];
        }
    } catch (e) {
        log(`Failed to scan tempDir: ${e}`);
    }
    const legacy = path.join(tempDir, 'callcanvas.json');
    if (fs.existsSync(legacy)) {
        log(`Output file from legacy: ${legacy}`);
        return legacy;
    }
    return null;
}

/**
 * Detect the Java project root from the active JSON file location or workspace search.
 * Used by both analyzeNextLevelJava and analyzeIncomingCallsJava.
 */
async function resolveJavaProjectRoot(
    activeJsonPath: vscode.Uri | undefined,
    workspaceRoot: string
): Promise<string> {
    let projectRoot = workspaceRoot;

    if (activeJsonPath) {
        log(`Using JSON file location to detect project root: ${activeJsonPath.fsPath}`);
        let currentDir = path.dirname(activeJsonPath.fsPath);
        while (currentDir !== workspaceRoot && currentDir !== path.dirname(currentDir)) {
            const pomPath = path.join(currentDir, 'pom.xml');
            const gradlePath = path.join(currentDir, 'build.gradle');
            if (fs.existsSync(pomPath) || fs.existsSync(gradlePath)) {
                projectRoot = currentDir;
                log(`Found project root from JSON location: ${projectRoot}`);
                break;
            }
            currentDir = path.dirname(currentDir);
        }
        if (projectRoot === workspaceRoot && activeJsonPath.fsPath.includes('/build/')) {
            const buildIndex = activeJsonPath.fsPath.indexOf('/build/');
            projectRoot = activeJsonPath.fsPath.substring(0, buildIndex);
            log(`Inferred project root from build directory: ${projectRoot}`);
        }
    } else {
        log(`No JSON path, searching for project files in workspace: ${workspaceRoot}`);
        const pomFiles = await vscode.workspace.findFiles('**/pom.xml', '**/node_modules/**', 10);
        const gradleFiles = await vscode.workspace.findFiles('**/build.gradle', '**/node_modules/**', 10);

        if (pomFiles.length > 0 || gradleFiles.length > 0) {
            const allProjectFiles = [...pomFiles, ...gradleFiles];
            let closestProjectFile = allProjectFiles[0];
            let minDepth = closestProjectFile.fsPath.split(path.sep).length;

            for (const projectFile of allProjectFiles) {
                const depth = projectFile.fsPath.split(path.sep).length;
                if (depth < minDepth) {
                    minDepth = depth;
                    closestProjectFile = projectFile;
                }
            }

            projectRoot = path.dirname(closestProjectFile.fsPath);
            log(`Found project root from workspace search: ${projectRoot}`);
        } else {
            log(`No pom.xml or build.gradle found, using workspace root: ${projectRoot}`);
        }
    }

    log(`==> Initial project root: ${projectRoot}`);
    return projectRoot;
}

/**
 * Analyze the next level of call hierarchy for a selected window (Java-specific)
 */
export async function analyzeNextLevelJava(
    windowData: { id?: string; displayName: string; filePath: string; code: string; startLine: number },
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    activeJsonPath: vscode.Uri | undefined,
    workspaceRoot: string
): Promise<void> {
    const perfEnabled = isPerfLogEnabled();
    const opName = 'analyzeNextLevel';
    let totalStart = 0;
    if (perfEnabled) { totalStart = Date.now(); }

    // Try to use Java Call Hierarchy extension's API for accurate method signature resolution
    log(`Resolving method signature...`);
    let methodSignature: string | null = null;

    // Use relative path if available, as the API will resolve it correctly
    const filePathForApi = windowData.filePath;

    let t0 = 0;
    if (perfEnabled) { t0 = Date.now(); }
    try {
        // Try Java Call Hierarchy extension's API first
        log(`Trying Java Call Hierarchy API with file: ${filePathForApi}, line: ${windowData.startLine}`);
        methodSignature = await vscode.commands.executeCommand<string | null>(
            'javaCallHierarchy.resolveMethodSignature',
            filePathForApi,
            windowData.startLine
        );
        if (methodSignature) {
            log(`Got method signature from Java Call Hierarchy API: ${methodSignature}`);
        }
    } catch (error) {
        log(`Java Call Hierarchy API not available: ${error}`);
    }

    // Fallback to local extraction if API is not available
    if (!methodSignature) {
        log(`Falling back to local method signature extraction...`);
        methodSignature = extractMethodSignature(windowData.displayName, windowData.code, windowData.filePath);
        log(`Extracted method signature (fallback): ${methodSignature}`);
    }
    if (perfEnabled) { perfLog(opName, 'resolveSignature', Date.now() - t0); }

    if (!methodSignature) {
        logError('Could not extract method signature from the selected window');
        vscode.window.showErrorMessage('Could not extract method signature from the selected window');
        return;
    }

    // Detect project root from JSON file location (not workspace root)
    log(`Detecting project root...`);
    let t1 = 0;
    if (perfEnabled) { t1 = Date.now(); }
    const projectRoot = await resolveJavaProjectRoot(activeJsonPath, workspaceRoot);
    if (perfEnabled) { perfLog(opName, 'projectDetection', Date.now() - t1); }

    // Check for multi-module project
    let t2 = 0;
    if (perfEnabled) { t2 = Date.now(); }
    const multiModuleRoot = findMultiModuleRoot(projectRoot);
    const srcPaths: string[] = [];
    const classesPaths: string[] = [];

    if (multiModuleRoot) {
        log(`Detected multi-module project root: ${multiModuleRoot}`);
        const modules = findSubModules(multiModuleRoot);
        log(`Found modules: ${modules.join(', ')}`);

        // Collect source paths from all modules
        for (const modulePath of modules) {
            const srcPath = path.join(modulePath, 'src', 'main', 'java');
            if (fs.existsSync(srcPath)) {
                srcPaths.push(srcPath);
                log(`Added module source path: ${srcPath}`);
            }

            // Check for Gradle classes
            const gradleClasses = path.join(modulePath, 'build', 'classes', 'java', 'main');
            if (fs.existsSync(gradleClasses)) {
                classesPaths.push(gradleClasses);
            }

            // Check for Maven classes
            const mavenClasses = path.join(modulePath, 'target', 'classes');
            if (fs.existsSync(mavenClasses)) {
                classesPaths.push(mavenClasses);
            }
        }
    } else {
        // Single module project
        const srcPath = path.join(projectRoot, 'src', 'main', 'java');
        if (fs.existsSync(srcPath)) {
            srcPaths.push(srcPath);
            log(`Single module source path: ${srcPath}`);
        }

        // Check for Gradle classes
        const gradleClasses = path.join(projectRoot, 'build', 'classes', 'java', 'main');
        if (fs.existsSync(gradleClasses)) {
            classesPaths.push(gradleClasses);
        }

        // Check for Maven classes
        const mavenClasses = path.join(projectRoot, 'target', 'classes');
        if (fs.existsSync(mavenClasses)) {
            classesPaths.push(mavenClasses);
        }
    }

    if (perfEnabled) { perfLog(opName, 'multiModuleDetection', Date.now() - t2, `srcPaths:${srcPaths.length},classesPaths:${classesPaths.length}`); }

    if (srcPaths.length === 0) {
        logError(`No source directories found in project: ${projectRoot}`);
        vscode.window.showErrorMessage('Source directory not found');
        return;
    }

    log(`Total source paths: ${srcPaths.length}`);
    log(`Total classes paths: ${classesPaths.length}`);

    // Use multi-module root if detected, otherwise use project root
    const effectiveProjectRoot = multiModuleRoot || projectRoot;
    log(`Effective project root for --workspace: ${effectiveProjectRoot}`);

    // Find the CLI JAR
    log(`Finding analyzer JAR...`);
    const jarPath = findAnalyzerJar(context, workspaceRoot);
    log(`JAR path: ${jarPath}`);
    if (!jarPath) {
        logError('Could not find java-call-hierarchy-analyzer.jar');
        vscode.window.showErrorMessage('Could not find java-call-hierarchy-analyzer.jar');
        return;
    }

    // Check if Java is available
    log(`Finding Java path...`);
    const javaPath = await findJavaPath();
    log(`Java path: ${javaPath}`);
    if (!javaPath) {
        logError('Java not found');
        vscode.window.showErrorMessage('Java not found. Please install Java 21 or higher.');
        return;
    }

    // Create unique temp directory for output (unique name prevents stale data from parallel runs)
    const tempDir = path.join(workspaceRoot, '.callcanvas-temp-' + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });
    log(`Temp directory: ${tempDir}`);

    // Helper to clean up temp directory on all exit paths
    const cleanupTempDir = () => {
        try {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
                log(`Cleaned up temp files`);
            }
        } catch (e) {
            log(`Failed to clean up temp dir: ${e}`);
        }
    };

    // Read viewer layout settings used by CLI callcanvas output.
    const viewerConfig = vscode.workspace.getConfiguration('callcanvas');
    const windowWidth = viewerConfig.get<number>('windowWidth', 600);

    // Build CLI command with comma-separated source paths for multi-module support
    const args = [
        '-jar', jarPath,
        '--src', srcPaths.join(','),
        '--root', methodSignature,
        '--depth', '1',
        '--format', 'callcanvas',
        '--width', String(windowWidth),
        '--workspace', effectiveProjectRoot,
        '--out', tempDir
    ];

    // Add debug flag from configuration
    const config = vscode.workspace.getConfiguration('javaCallHierarchy');
    const debugEnabled = config.get<boolean>('debug', false);
    if (debugEnabled) {
        args.push('--debug');
    }

    // Auto-add --timing when performance logging is enabled
    if (perfEnabled) {
        args.push('--timing');
    }

    // Add classes directories if available
    if (classesPaths.length > 0) {
        args.push('--classes', classesPaths.join(','));
        log(`Added ${classesPaths.length} classes paths`);
    } else {
        log(`No compiled classes found`);
    }

    log(`Command: "${javaPath}" ${args.map(a => `"${a}"`).join(' ')}`);

    // Show progress
    log(`Starting CLI execution...`);
    let cliStart = 0;
    if (perfEnabled) { cliStart = Date.now(); }
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Analyzing: ${methodSignature}`,
        cancellable: false
    }, async () => {
        return new Promise<void>((resolve, reject) => {
            const child = spawn(javaPath, args, { cwd: workspaceRoot });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('error', (error) => {
                logError(`CLI Error: ${error.message}`);
                vscode.window.showErrorMessage(`Analysis failed: ${error.message}`);
                cleanupTempDir();
                reject(error);
            });

            child.on('close', (code) => {
                if (perfEnabled) {
                    perfLog(opName, 'javaCliExecution', Date.now() - cliStart, `exitCode:${code ?? -1}`);
                    emitJavaTimingLines(opName, stderr);
                }

                log(`CLI execution completed with code: ${code}`);
                log(`stdout: ${stdout}`);
                log(`stderr: ${stderr}`);

                if (code !== 0) {
                    logError(`CLI exited with code ${code}`);
                    logError(`stderr: ${stderr}`);
                    vscode.window.showErrorMessage(`Analysis failed: ${stderr || `Exit code ${code}`}`);
                    cleanupTempDir();
                    if (perfEnabled) { perfTotal(opName, Date.now() - totalStart); }
                    reject(new Error(`Exit code ${code}`));
                    return;
                }

                const outputPath = resolveCallCanvasCliOutputPath(tempDir, stderr);
                log(`Checking output file: ${outputPath ?? '(none)'}`);

                if (!outputPath) {
                    logError('CallCanvas output file not found in temp dir');
                    vscode.window.showWarningMessage('No results found for this method');
                    cleanupTempDir();
                    if (perfEnabled) { perfTotal(opName, Date.now() - totalStart); }
                    resolve();
                    return;
                }

                let parseStart = 0;
                if (perfEnabled) { parseStart = Date.now(); }
                try {
                    const resultContent = fs.readFileSync(outputPath, 'utf8');
                    log(`Output file content length: ${resultContent.length}`);

                    const resultJson = JSON.parse(resultContent);
                    log(`Parsed result: ${resultJson.windows?.length || 0} windows, ${resultJson.connections?.length || 0} connections`);
                    if (perfEnabled) { perfLog(opName, 'parseResult', Date.now() - parseStart, `windows:${resultJson.windows?.length || 0},connections:${resultJson.connections?.length || 0}`); }

                    // Send merged data to webview
                    panel.webview.postMessage({
                        command: 'mergeCallCanvasData',
                        data: resultJson,
                        sourceWindowDisplayName: windowData.displayName,
                        sourceWindowId: windowData.id
                    });

                    vscode.window.showInformationMessage(`Found ${resultJson.windows?.length || 0} methods`);
                    log(`Successfully sent data to webview`);
                } catch (parseError) {
                    logError(`Failed to parse analysis result: ${parseError}`);
                    vscode.window.showErrorMessage(`Failed to parse analysis result: ${parseError}`);
                } finally {
                    cleanupTempDir();
                }

                if (perfEnabled) { perfTotal(opName, Date.now() - totalStart); }
                resolve();
            });
        });
    });
}

/**
 * Re-analyze the root method for Java files using javaCallHierarchy.analyzeMethod API.
 */
export async function reanalyzeRootJava(
    rootWindow: { displayName: string; filePath: string; code: any; startLine: number },
    absoluteFilePath: string,
    panel: vscode.WebviewPanel,
    activeJsonPath: vscode.Uri
): Promise<void> {
    const perfEnabled = isPerfLogEnabled();
    const opName = 'reanalyzeRoot';
    let totalStart = 0;
    if (perfEnabled) { totalStart = Date.now(); }

    // Resolve method signature via Java Call Hierarchy API
    let t0 = 0;
    if (perfEnabled) { t0 = Date.now(); }
    let methodSignature: string | null = null;
    try {
        methodSignature = await vscode.commands.executeCommand<string | null>(
            'javaCallHierarchy.resolveMethodSignature',
            absoluteFilePath,
            rootWindow.startLine
        );
        if (methodSignature) {
            log(`Got method signature from Java Call Hierarchy API: ${methodSignature}`);
        }
    } catch (error) {
        log(`Java Call Hierarchy API not available: ${error}`);
    }

    // Fallback: extract from displayName
    if (!methodSignature) {
        methodSignature = extractMethodSignature(rootWindow.displayName, rootWindow.code, rootWindow.filePath);
        log(`Extracted method signature (fallback): ${methodSignature}`);
    }
    if (perfEnabled) { perfLog(opName, 'resolveSignature', Date.now() - t0); }

    if (!methodSignature) {
        vscode.window.showErrorMessage('メソッドシグネチャを解決できませんでした');
        return;
    }

    // Get depth from configuration (default matches package.json javaCallHierarchy.depth)
    const config = vscode.workspace.getConfiguration('javaCallHierarchy');
    const depth = config.get<number>('depth', 5);

    log(`Re-analyzing with signature: ${methodSignature}, depth: ${depth}, filePath: ${absoluteFilePath}`);

    let apiStart = 0;
    if (perfEnabled) { apiStart = Date.now(); }
    try {
        const result = await vscode.commands.executeCommand<{ success: boolean; data?: any; error?: string }>(
            'javaCallHierarchy.analyzeMethod',
            { filePath: absoluteFilePath, methodSignature, depth }
        );
        if (perfEnabled) { perfLog(opName, 'apiCall', Date.now() - apiStart); }

        if (result?.success && result.data) {
            // Preserve positions from current JSON
            const newData = result.data;

            // Overwrite the JSON file with new data
            try {
                fs.writeFileSync(activeJsonPath.fsPath, JSON.stringify(newData, null, 2), 'utf8');
                log(`Saved re-analyzed data to: ${activeJsonPath.fsPath}`);
            } catch (saveError) {
                log(`Failed to save JSON: ${saveError}`);
            }

            // Reload entire viewer with new data
            panel.webview.postMessage({
                command: 'reloadData',
                data: newData
            });
            vscode.window.showInformationMessage(
                `再解析完了: ${newData.windows?.length || 0} メソッド`
            );
        } else {
            vscode.window.showErrorMessage(`再解析失敗: ${result?.error || '不明なエラー'}`);
        }
    } catch (error) {
        if (perfEnabled) { perfLog(opName, 'apiCall', Date.now() - apiStart); }
        vscode.window.showErrorMessage(
            'Java Call Hierarchy拡張がインストールされていないか、エラーが発生しました'
        );
    }
    if (perfEnabled) { perfTotal(opName, Date.now() - totalStart); }
}

/**
 * Analyze incoming calls for Java files (extracted from analyzeIncomingCalls)
 * @param depth Number of incoming call levels to analyze (1 = direct callers, -1 = recursive to root)
 */
export async function analyzeIncomingCallsJava(
    windowData: { id?: string; displayName: string; filePath: string; code: string; startLine: number },
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    activeJsonPath: vscode.Uri | undefined,
    workspaceRoot: string,
    depth: number = 1,
    progressTitle?: string
): Promise<void> {
    const perfEnabled = isPerfLogEnabled();
    const opName = 'analyzeIncomingCalls';
    let totalStart = 0;
    if (perfEnabled) { totalStart = Date.now(); }

    // Try to use Java Call Hierarchy extension's API for accurate method signature resolution
    log(`Resolving method signature...`);
    let methodSignature: string | null = null;

    // Use relative path if available, as the API will resolve it correctly
    const filePathForApi = windowData.filePath;

    let t0 = 0;
    if (perfEnabled) { t0 = Date.now(); }
    try {
        // Try Java Call Hierarchy extension's API first
        log(`Trying Java Call Hierarchy API with file: ${filePathForApi}, line: ${windowData.startLine}`);
        methodSignature = await vscode.commands.executeCommand<string | null>(
            'javaCallHierarchy.resolveMethodSignature',
            filePathForApi,
            windowData.startLine
        );
        if (methodSignature) {
            log(`Got method signature from Java Call Hierarchy API: ${methodSignature}`);
        }
    } catch (error) {
        log(`Java Call Hierarchy API not available: ${error}`);
    }

    // Fallback to local extraction if API is not available
    if (!methodSignature) {
        log(`Falling back to local method signature extraction...`);
        methodSignature = extractMethodSignature(windowData.displayName, windowData.code, windowData.filePath);
        log(`Extracted method signature (fallback): ${methodSignature}`);
    }
    if (perfEnabled) { perfLog(opName, 'resolveSignature', Date.now() - t0); }

    if (!methodSignature) {
        logError('Could not extract method signature from the selected window');
        vscode.window.showErrorMessage('Could not extract method signature from the selected window');
        return;
    }

    // Detect project root from JSON file location (not workspace root)
    log(`Detecting project root...`);
    let t1 = 0;
    if (perfEnabled) { t1 = Date.now(); }
    const projectRoot = await resolveJavaProjectRoot(activeJsonPath, workspaceRoot);
    if (perfEnabled) { perfLog(opName, 'projectDetection', Date.now() - t1); }

    // Check for multi-module project
    let t2 = 0;
    if (perfEnabled) { t2 = Date.now(); }
    const multiModuleRoot = findMultiModuleRoot(projectRoot);
    const srcPaths: string[] = [];
    const classesPaths: string[] = [];

    if (multiModuleRoot) {
        log(`Detected multi-module project root: ${multiModuleRoot}`);
        const modules = findSubModules(multiModuleRoot);
        log(`Found modules: ${modules.join(', ')}`);

        // Collect source paths from all modules
        for (const modulePath of modules) {
            const srcPath = path.join(modulePath, 'src', 'main', 'java');
            if (fs.existsSync(srcPath)) {
                srcPaths.push(srcPath);
                log(`Added module source path: ${srcPath}`);
            }

            // Check for Gradle classes
            const gradleClasses = path.join(modulePath, 'build', 'classes', 'java', 'main');
            if (fs.existsSync(gradleClasses)) {
                classesPaths.push(gradleClasses);
            }

            // Check for Maven classes
            const mavenClasses = path.join(modulePath, 'target', 'classes');
            if (fs.existsSync(mavenClasses)) {
                classesPaths.push(mavenClasses);
            }
        }
    } else {
        // Single module project
        const srcPath = path.join(projectRoot, 'src', 'main', 'java');
        if (fs.existsSync(srcPath)) {
            srcPaths.push(srcPath);
            log(`Single module source path: ${srcPath}`);
        }

        // Check for Gradle classes
        const gradleClasses = path.join(projectRoot, 'build', 'classes', 'java', 'main');
        if (fs.existsSync(gradleClasses)) {
            classesPaths.push(gradleClasses);
        }

        // Check for Maven classes
        const mavenClasses = path.join(projectRoot, 'target', 'classes');
        if (fs.existsSync(mavenClasses)) {
            classesPaths.push(mavenClasses);
        }
    }
    if (perfEnabled) { perfLog(opName, 'multiModuleDetection', Date.now() - t2, `srcPaths:${srcPaths.length},classesPaths:${classesPaths.length}`); }

    if (srcPaths.length === 0) {
        logError(`No source directories found in project: ${projectRoot}`);
        vscode.window.showErrorMessage('Source directory not found');
        return;
    }

    log(`Total source paths: ${srcPaths.length}`);
    log(`Total classes paths: ${classesPaths.length}`);

    // Use multi-module root if detected, otherwise use project root
    const effectiveProjectRoot = multiModuleRoot || projectRoot;
    log(`Effective project root for --workspace: ${effectiveProjectRoot}`);

    // Find the CLI JAR
    log(`Finding analyzer JAR...`);
    const jarPath = findAnalyzerJar(context, workspaceRoot);
    log(`JAR path: ${jarPath}`);
    if (!jarPath) {
        vscode.window.showErrorMessage('Analyzer JAR not found');
        return;
    }

    // Check if Java is available
    log(`Finding Java path...`);
    const javaPath = await findJavaPath();
    log(`Java path: ${javaPath}`);
    if (!javaPath) {
        vscode.window.showErrorMessage('Java not found. Please install Java 21 or higher.');
        return;
    }

    const config = vscode.workspace.getConfiguration('javaCallHierarchy');
    const viewerConfig = vscode.workspace.getConfiguration('callcanvas');
    const windowWidth = viewerConfig.get<number>('windowWidth', 600);

    // Create temporary output directory
    const tempDir = path.join(workspaceRoot, '.callcanvas-temp-incoming-' + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });
    log(`Temp output dir: ${tempDir}`);

    // Build command arguments with --direction incoming and comma-separated source paths for multi-module support
    // Use multi-module root for --workspace so cache/index is found correctly
    const args = [
        '-jar', jarPath,
        '--src', srcPaths.join(','),  // Comma-separated for multi-module support
        '--root', methodSignature,
        '--depth', String(depth),
        '--format', 'callcanvas',
        '--width', String(windowWidth),
        '--workspace', effectiveProjectRoot,
        '--out', tempDir,
        '--direction', 'incoming'  // Use incoming direction
    ];

    // Add debug flag from configuration
    const debugEnabled = config.get<boolean>('debug', false);
    if (debugEnabled) {
        args.push('--debug');
    }

    // Auto-add --timing when performance logging is enabled
    if (perfEnabled) {
        args.push('--timing');
    }

    // Add classes directories if available (comma-separated for multi-module support)
    if (classesPaths.length > 0) {
        args.push('--classes', classesPaths.join(','));
        log(`Added ${classesPaths.length} classes paths`);
    } else {
        log(`No compiled classes found`);
    }

    log(`Command: "${javaPath}" ${args.map(a => `"${a}"`).join(' ')}`);

    // Helper to clean up temp directory
    const cleanupTempDir = () => {
        try {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
                log(`Cleaned up temp files`);
            }
        } catch (e) {
            log(`Failed to clean up temp dir: ${e}`);
        }
    };

    // Show progress
    log(`Starting CLI execution...`);
    let cliStart = 0;
    if (perfEnabled) { cliStart = Date.now(); }
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: progressTitle ?? `Analyzing incoming calls: ${methodSignature}`,
        cancellable: false
    }, async () => {
        return new Promise<void>((resolve, reject) => {
            const child = spawn(javaPath, args, { cwd: workspaceRoot });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => {
                stdout += data.toString();
                log(`stdout: ${data.toString()}`);
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString();
                log(`stderr: ${data.toString()}`);
            });

            child.on('error', (error) => {
                logError(`Failed to start CLI: ${error.message}`);
                vscode.window.showErrorMessage(`Failed to start CLI: ${error.message}`);
                cleanupTempDir();
                reject(error);
            });

            child.on('close', (code) => {
                if (perfEnabled) {
                    perfLog(opName, 'javaCliExecution', Date.now() - cliStart, `exitCode:${code ?? -1}`);
                    emitJavaTimingLines(opName, stderr);
                }

                log(`CLI execution completed with code: ${code}`);
                log(`stdout: ${stdout}`);
                log(`stderr: ${stderr}`);

                if (code !== 0) {
                    logError(`CLI execution failed with code ${code}`);
                    logError(`stderr: ${stderr}`);
                    vscode.window.showErrorMessage(`Analysis failed with code ${code}`);
                    cleanupTempDir();
                    if (perfEnabled) { perfTotal(opName, Date.now() - totalStart); }
                    resolve();
                    return;
                }

                const outputPath = resolveCallCanvasCliOutputPath(tempDir, stderr);

                if (!outputPath) {
                    logError(`Output file not found in: ${tempDir}`);
                    vscode.window.showErrorMessage(`Output file not found`);
                    cleanupTempDir();
                    if (perfEnabled) { perfTotal(opName, Date.now() - totalStart); }
                    resolve();
                    return;
                }

                let parseStart = 0;
                if (perfEnabled) { parseStart = Date.now(); }
                try {
                    const resultContent = fs.readFileSync(outputPath, 'utf8');
                    log(`Output file content length: ${resultContent.length}`);

                    const resultJson = JSON.parse(resultContent);
                    log(`Parsed result: ${resultJson.windows?.length || 0} windows, ${resultJson.connections?.length || 0} connections`);
                    if (perfEnabled) { perfLog(opName, 'parseResult', Date.now() - parseStart, `windows:${resultJson.windows?.length || 0},connections:${resultJson.connections?.length || 0}`); }

                    // Send merged data to webview
                    panel.webview.postMessage({
                        command: 'mergeCallCanvasData',
                        data: resultJson,
                        sourceWindowDisplayName: windowData.displayName,
                        sourceWindowId: windowData.id
                    });

                    vscode.window.showInformationMessage(`Found ${resultJson.windows?.length || 0} callers`);
                    log(`Successfully sent data to webview`);
                } catch (parseError) {
                    logError(`Failed to parse analysis result: ${parseError}`);
                    vscode.window.showErrorMessage(`Failed to parse analysis result: ${parseError}`);
                } finally {
                    cleanupTempDir();
                }

                if (perfEnabled) { perfTotal(opName, Date.now() - totalStart); }
                resolve();
            });
        });
    });
}
