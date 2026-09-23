import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';

// 出力チャンネル（デバッグ出力用）
let outputChannel: vscode.OutputChannel | null = null;

export function setOutputChannel(channel: vscode.OutputChannel): void {
    outputChannel = channel;
}

function log(message: string): void {
    if (outputChannel) {
        outputChannel.appendLine(message);
    }
    console.log(message);
}

export interface AnalysisResult {
    success: boolean;
    data?: CallHierarchyData;
    error?: string;
    callcanvasJsonPath?: string;
}

export interface CallHierarchyData {
    root: MethodNode;
}

export interface MethodNode {
    method: string;
    shortName: string;
    line?: number;
    file?: string;
    calls: MethodNode[];
}

export type OutputFormat = 'json' | 'callcanvas';

export interface AnalyzerOptions {
    depth: number;
    excludePatterns: string;
    javaPath: string;
    languageLevel: string;
    debug: boolean;
    quiet?: boolean;  // Quiet mode (suppress logs, show only performance summary)
    timing?: boolean;  // Timing mode (shows block-level performance metrics)
    windowWidth?: number;  // CallCanvas output window width
    direction?: 'outgoing' | 'incoming';  // Analysis direction (default: outgoing)
}

/**
 * Run the Java Call Hierarchy Analyzer JAR and return the results.
 */

/**
 * Record what produced a CallCanvas JSON so the viewer's "ルート再解析" can replay
 * the same analysis instead of guessing the root from window order.
 * `rootFilePath` uses the same workspace-relative convention as window.filePath.
 */
function stampAnalysisMetadata(
    callcanvasJsonPath: string | undefined,
    workspaceRoot: string,
    sourceFilePath: string,
    record: { root?: string; rootClass?: string; direction: string; depth: number }
): void {
    if (!callcanvasJsonPath || !fs.existsSync(callcanvasJsonPath)) {
        return;
    }
    try {
        const raw = fs.readFileSync(callcanvasJsonPath, 'utf8');
        const json = JSON.parse(raw);
        let rootFilePath = path.relative(workspaceRoot, sourceFilePath);
        if (!rootFilePath || rootFilePath.startsWith('..')) {
            rootFilePath = sourceFilePath;
        }
        const analysis: any = {
            language: 'java',
            rootFilePath: rootFilePath.split(path.sep).join('/'),
            direction: record.direction,
            depth: record.depth
        };
        if (record.root) {
            analysis.root = record.root;
        }
        if (record.rootClass) {
            analysis.rootClass = record.rootClass;
        }
        if (Array.isArray(json.windows) && json.windows.length > 0 && json.windows[0].id) {
            analysis.rootWindowId = json.windows[0].id;
        }
        json.metadata = Object.assign({}, json.metadata || {}, { analysis });
        fs.writeFileSync(callcanvasJsonPath, JSON.stringify(json, null, 2), 'utf8');
    } catch (error) {
        log('[Java Call Hierarchy] Failed to stamp analysis metadata: ' + error);
    }
}

export async function analyzeCallHierarchy(
    extensionPath: string,
    documentUri: vscode.Uri,
    methodSignature: string,
    options: AnalyzerOptions,
    format: OutputFormat = 'json',
    workspaceBoundary?: string,
    allowImplicitMultiModule: boolean = true
): Promise<AnalysisResult> {
    const startTime = Date.now();
    
    // バージョン情報を取得（package.jsonから）
    const packageJson = require(extensionPath + '/package.json');
    const version = packageJson.version || 'unknown';
    
    if (options.debug) {
        log('[Java Call Hierarchy] === Extension v' + version + ' ===');
        log('[Java Call Hierarchy] START ' + (format === 'callcanvas' ? 'Export CallCanvas JSON' : 'Analysis'));
        log('[Java Call Hierarchy]   Method: ' + methodSignature);
        log('[Java Call Hierarchy]   Depth: ' + options.depth);
        log('[Java Call Hierarchy]   File: ' + documentUri.fsPath);
    }
    
    // Find project root by looking for src/main/java in the file path
    const projectRoot = findProjectRoot(documentUri.fsPath);
    if (!projectRoot) {
        return {
            success: false,
            error: 'Could not determine project root. Make sure the file is in a standard Java project structure (src/main/java).'
        };
    }

    if (options.debug) {
        log('[Java Call Hierarchy]   Project: ' + projectRoot);
    }

    // Detect project structure
    const detectStart = Date.now();
    const projectInfo = await detectProjectStructure(projectRoot, options.debug, workspaceBoundary, allowImplicitMultiModule);
    const detectTime = Date.now() - detectStart;
    
    if (options.debug) {
        log('[Java Call Hierarchy] Project detection completed in ' + detectTime + 'ms');
        log('[Java Call Hierarchy] Detected structure:');
        log('  srcDir: ' + (projectInfo.srcDir || '(not found)'));
        log('  classesDir: ' + (projectInfo.classesDir || '(not found)'));
        log('  jarFile: ' + (projectInfo.jarFile || '(not found)'));
        log('  dependencyDirs: ' + (projectInfo.dependencyDirs?.join(', ') || '(none)'));
        log('  multiModuleRoot: ' + (projectInfo.multiModuleRoot || '(not a multi-module project)'));
    }
    
    if (!projectInfo.srcDir) {
        return {
            success: false,
            error: 'Could not find Java source directory (src/main/java)'
        };
    }

    if (!projectInfo.classesDir) {
        return {
            success: false,
            error: 'Could not find compiled classes. Please build the project first (./gradlew build or ./mvnw compile)'
        };
    }

    // Find JAR file
    const jarPath = path.join(extensionPath, 'resources', 'java-call-hierarchy-analyzer.jar');
    if (!fs.existsSync(jarPath)) {
        return {
            success: false,
            error: `Analyzer JAR not found at ${jarPath}`
        };
    }

    // Determine Java executable
    const javaExe = options.javaPath || 'java';

    // Create output directory in project's build folder
    const outputDir = path.join(projectRoot, 'build', 'call-hierarchy-output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Build command arguments
    // Use multiModuleRoot if available, otherwise use projectRoot for --workspace
    // This ensures cache/index is created at the correct location (multi-module root for multi-module projects)
    const workspaceRoot = projectInfo.multiModuleRoot || projectRoot;
    const formatArg = format === 'callcanvas' ? 'json,callcanvas' : 'json';
    const args = [
        '-jar', jarPath,
        '--src', projectInfo.srcDir,
        '--classes', projectInfo.classesDir,
        '--root', methodSignature,
        '--depth', options.depth.toString(),
        '--format', formatArg,
        '--out', outputDir,
        '--workspace', workspaceRoot,
        '--lang-level', options.languageLevel
    ];

    // Add classpath: combine project JAR and build-tool-resolved dependency JARs
    {
        const cpParts = [projectInfo.jarFile, projectInfo.resolvedClasspath].filter(Boolean) as string[];
        if (cpParts.length > 0) {
            args.push('--cp', cpParts.join(','));
        }
        if (options.debug && projectInfo.resolvedClasspath) {
            const count = projectInfo.resolvedClasspath.split(',').filter(Boolean).length;
            log(`[Java Call Hierarchy]   resolvedClasspath: ${count} JARs from build tool`);
        }
    }

    // Add dependency directories for classpath resolution
    if (projectInfo.dependencyDirs && projectInfo.dependencyDirs.length > 0) {
        args.push('--cpdir', projectInfo.dependencyDirs.join(','));
    }

    // Add exclude patterns
    if (options.excludePatterns) {
        args.push('--exclude', options.excludePatterns);
    }

    // Add window width for CallCanvas output
    if (options.windowWidth) {
        args.push('--width', options.windowWidth.toString());
    }

    // Add debug flag
    if (options.debug) {
        args.push('--debug');
    }
    
    // Add quiet flag
    if (options.quiet) {
        args.push('--quiet');
    }
    
    // Add timing flag
    if (options.timing) {
        args.push('--timing');
    }

    // Add direction flag
    if (options.direction) {
        args.push('--direction', options.direction);
    }

    // Log command if debug enabled
    if (options.debug) {
        log('[Java Call Hierarchy] Executing: ' + javaExe + ' ' + args.join(' '));
        if (outputChannel) {
            outputChannel.show(true); // デバッグモードなら出力パネルを表示
        }
    }

    // Execute JAR
    try {
        const execStart = Date.now();
        const result = await executeJar(javaExe, args, projectRoot, options.debug);
        const execTime = Date.now() - execStart;
        const { stdout: output, stderr } = result;

        if (options.debug) {
            log('[Java Call Hierarchy] Analyzer completed in ' + execTime + 'ms');
        }

        // Log stderr if debug enabled
        if (options.debug && stderr) {
            log('[Java Call Hierarchy] Debug output:');
            for (const line of stderr.split('\n')) {
                log('  ' + line);
            }
        }

        // Parse callcanvas filename from Java stderr (stdout is reserved for JSON)
        let callcanvasFilename: string | undefined;
        const callcanvasMarker = '[CALLCANVAS_FILE]';
        const stderrLines = stderr ? stderr.split('\n') : [];
        for (const line of stderrLines) {
            if (line.includes(callcanvasMarker)) {
                const fullPath = line.substring(line.indexOf(callcanvasMarker) + callcanvasMarker.length).trim();
                callcanvasFilename = fullPath;
                if (options.debug) {
                    log('[Java Call Hierarchy] Parsed callcanvas file from stderr: ' + callcanvasFilename);
                }
                break;
            }
        }

        // Parse JSON output
        const data = parseAnalyzerOutput(output);
        if (!data) {
            return {
                success: false,
                error: 'Failed to parse analyzer output'
            };
        }

        // Check for callcanvas.json if format includes callcanvas
        let callcanvasJsonPath: string | undefined;
        if (format === 'callcanvas') {
            // Strategy 1: Use parsed filename from Java output
            if (callcanvasFilename && fs.existsSync(callcanvasFilename)) {
                callcanvasJsonPath = callcanvasFilename;
                if (options.debug) {
                    log('[Java Call Hierarchy] Found callcanvas file (from Java output): ' + callcanvasJsonPath);
                }
            }
            // Strategy 2: Search for callcanvas_*.json pattern
            else {
                const files = fs.readdirSync(outputDir);
                const callcanvasFiles = files.filter(f => f.startsWith('callcanvas_') && f.endsWith('.json'));
                if (callcanvasFiles.length > 0) {
                    // Use the most recently modified file
                    callcanvasFiles.sort((a, b) => {
                        const statA = fs.statSync(path.join(outputDir, a));
                        const statB = fs.statSync(path.join(outputDir, b));
                        return statB.mtimeMs - statA.mtimeMs;
                    });
                    callcanvasJsonPath = path.join(outputDir, callcanvasFiles[0]);
                    if (options.debug) {
                        log('[Java Call Hierarchy] Found callcanvas file (by pattern): ' + callcanvasJsonPath);
                    }
                }
                // Strategy 3: Fallback to legacy callcanvas.json (backward compatibility)
                else {
                    const legacyPath = path.join(outputDir, 'callcanvas.json');
                    if (fs.existsSync(legacyPath)) {
                        callcanvasJsonPath = legacyPath;
                        if (options.debug) {
                            log('[Java Call Hierarchy] Found callcanvas file (legacy): ' + callcanvasJsonPath);
                        }
                    }
                }
            }

            if (!callcanvasJsonPath && options.debug) {
                log('[Java Call Hierarchy] WARNING: No callcanvas file found in: ' + outputDir);
            }
        }
        
        if (format === 'callcanvas') {
            stampAnalysisMetadata(callcanvasJsonPath, workspaceRoot, documentUri.fsPath, {
                root: methodSignature,
                direction: options.direction || 'outgoing',
                depth: options.depth
            });
        }

        if (options.debug) {
            const elapsed = Date.now() - startTime;
            log('[Java Call Hierarchy] END (total: ' + elapsed + 'ms)');
        }

        return {
            success: true,
            data: data,
            callcanvasJsonPath
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (options.debug) {
            const elapsed = Date.now() - startTime;
            log('[Java Call Hierarchy] END with error (total: ' + elapsed + 'ms)');
        }
        return {
            success: false,
            error: message
        };
    }
}

/**
 * Run the Java Call Hierarchy Analyzer JAR for class-level analysis (all methods in the class as roots).
 * Uses --root-class instead of --root. Does not pass --direction (outgoing is default).
 */
export async function analyzeCallHierarchyForClass(
    extensionPath: string,
    documentUri: vscode.Uri,
    classFqn: string,
    options: AnalyzerOptions,
    format: OutputFormat = 'json',
    workspaceBoundary?: string,
    allowImplicitMultiModule: boolean = true
): Promise<AnalysisResult> {
    const startTime = Date.now();

    const packageJson = require(extensionPath + '/package.json');
    const version = packageJson.version || 'unknown';

    if (options.debug) {
        log('[Java Call Hierarchy] === Extension v' + version + ' ===');
        log('[Java Call Hierarchy] START (class-level) ' + (format === 'callcanvas' ? 'Export CallCanvas JSON' : 'Analysis'));
        log('[Java Call Hierarchy]   Class: ' + classFqn);
        log('[Java Call Hierarchy]   Depth: ' + options.depth);
        log('[Java Call Hierarchy]   File: ' + documentUri.fsPath);
    }

    const projectRoot = findProjectRoot(documentUri.fsPath);
    if (!projectRoot) {
        return {
            success: false,
            error: 'Could not determine project root. Make sure the file is in a standard Java project structure (src/main/java).'
        };
    }

    if (options.debug) {
        log('[Java Call Hierarchy]   Project: ' + projectRoot);
    }

    const detectStart = Date.now();
    const projectInfo = await detectProjectStructure(projectRoot, options.debug, workspaceBoundary, allowImplicitMultiModule);
    const detectTime = Date.now() - detectStart;

    if (options.debug) {
        log('[Java Call Hierarchy] Project detection completed in ' + detectTime + 'ms');
        log('[Java Call Hierarchy] Detected structure:');
        log('  srcDir: ' + (projectInfo.srcDir || '(not found)'));
        log('  classesDir: ' + (projectInfo.classesDir || '(not found)'));
        log('  jarFile: ' + (projectInfo.jarFile || '(not found)'));
        log('  dependencyDirs: ' + (projectInfo.dependencyDirs?.join(', ') || '(none)'));
        log('  multiModuleRoot: ' + (projectInfo.multiModuleRoot || '(not a multi-module project)'));
    }

    if (!projectInfo.srcDir) {
        return { success: false, error: 'Could not find Java source directory (src/main/java)' };
    }
    if (!projectInfo.classesDir) {
        return {
            success: false,
            error: 'Could not find compiled classes. Please build the project first (./gradlew build or ./mvnw compile)'
        };
    }

    const jarPath = path.join(extensionPath, 'resources', 'java-call-hierarchy-analyzer.jar');
    if (!fs.existsSync(jarPath)) {
        return { success: false, error: `Analyzer JAR not found at ${jarPath}` };
    }

    const javaExe = options.javaPath || 'java';
    const outputDir = path.join(projectRoot, 'build', 'call-hierarchy-output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const workspaceRoot = projectInfo.multiModuleRoot || projectRoot;
    const formatArg = format === 'callcanvas' ? 'json,callcanvas' : 'json';
    const args = [
        '-jar', jarPath,
        '--src', projectInfo.srcDir,
        '--classes', projectInfo.classesDir,
        '--root-class', classFqn,
        '--depth', options.depth.toString(),
        '--format', formatArg,
        '--out', outputDir,
        '--workspace', workspaceRoot,
        '--lang-level', options.languageLevel
    ];

    {
        const cpParts = [projectInfo.jarFile, projectInfo.resolvedClasspath].filter(Boolean) as string[];
        if (cpParts.length > 0) {
            args.push('--cp', cpParts.join(','));
        }
        if (options.debug && projectInfo.resolvedClasspath) {
            const count = projectInfo.resolvedClasspath.split(',').filter(Boolean).length;
            log(`[Java Call Hierarchy]   resolvedClasspath: ${count} JARs from build tool`);
        }
    }
    if (projectInfo.dependencyDirs && projectInfo.dependencyDirs.length > 0) {
        args.push('--cpdir', projectInfo.dependencyDirs.join(','));
    }
    if (options.excludePatterns) {
        args.push('--exclude', options.excludePatterns);
    }
    if (options.windowWidth) {
        args.push('--width', options.windowWidth.toString());
    }
    if (options.debug) {
        args.push('--debug');
    }
    if (options.quiet) {
        args.push('--quiet');
    }
    if (options.timing) {
        args.push('--timing');
    }

    if (options.debug) {
        log('[Java Call Hierarchy] Executing: ' + javaExe + ' ' + args.join(' '));
        if (outputChannel) {
            outputChannel.show(true);
        }
    }

    try {
        const execStart = Date.now();
        const result = await executeJar(javaExe, args, projectRoot, options.debug);
        const execTime = Date.now() - execStart;
        const { stdout: output, stderr } = result;

        if (options.debug) {
            log('[Java Call Hierarchy] Analyzer completed in ' + execTime + 'ms');
        }
        if (options.debug && stderr) {
            log('[Java Call Hierarchy] Debug output:');
            for (const line of stderr.split('\n')) {
                log('  ' + line);
            }
        }

        let callcanvasFilename: string | undefined;
        const callcanvasMarker = '[CALLCANVAS_FILE]';
        const stderrLines = stderr ? stderr.split('\n') : [];
        for (const line of stderrLines) {
            if (line.includes(callcanvasMarker)) {
                callcanvasFilename = line.substring(line.indexOf(callcanvasMarker) + callcanvasMarker.length).trim();
                if (options.debug) {
                    log('[Java Call Hierarchy] Parsed callcanvas file from stderr: ' + callcanvasFilename);
                }
                break;
            }
        }

        const data = parseAnalyzerOutput(output);
        if (!data) {
            return { success: false, error: 'Failed to parse analyzer output' };
        }

        let callcanvasJsonPath: string | undefined;
        if (format === 'callcanvas') {
            if (callcanvasFilename && fs.existsSync(callcanvasFilename)) {
                callcanvasJsonPath = callcanvasFilename;
                if (options.debug) {
                    log('[Java Call Hierarchy] Found callcanvas file (from Java output): ' + callcanvasJsonPath);
                }
            } else {
                // Derive expected filename from classFqn (mirrors DepQueryCli.java logic).
                // Take everything after the last '.' or '$' to get the simple class name.
                const lastDot = classFqn.lastIndexOf('.');
                const lastDollar = classFqn.lastIndexOf('$');
                const cut = Math.max(lastDot, lastDollar);
                const simpleClassName = cut >= 0 ? classFqn.substring(cut + 1) : classFqn;
                const expectedPath = path.join(outputDir, 'callcanvas_' + simpleClassName + '.json');
                if (fs.existsSync(expectedPath)) {
                    callcanvasJsonPath = expectedPath;
                    if (options.debug) {
                        log('[Java Call Hierarchy] Found callcanvas file (by class name): ' + callcanvasJsonPath);
                    }
                } else {
                    const legacyPath = path.join(outputDir, 'callcanvas.json');
                    if (fs.existsSync(legacyPath)) {
                        callcanvasJsonPath = legacyPath;
                        if (options.debug) {
                            log('[Java Call Hierarchy] Found callcanvas file (legacy): ' + callcanvasJsonPath);
                        }
                    }
                }
            }
            if (!callcanvasJsonPath && options.debug) {
                log('[Java Call Hierarchy] WARNING: No callcanvas file found in: ' + outputDir);
            }
        }

        if (format === 'callcanvas') {
            stampAnalysisMetadata(callcanvasJsonPath, workspaceRoot, documentUri.fsPath, {
                rootClass: classFqn,
                direction: options.direction || 'outgoing',
                depth: options.depth
            });
        }

        if (options.debug) {
            const elapsed = Date.now() - startTime;
            log('[Java Call Hierarchy] END (total: ' + elapsed + 'ms)');
        }

        return {
            success: true,
            data: data,
            callcanvasJsonPath
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (options.debug) {
            const elapsed = Date.now() - startTime;
            log('[Java Call Hierarchy] END with error (total: ' + elapsed + 'ms)');
        }
        return {
            success: false,
            error: message
        };
    }
}

/**
 * Find the project root by looking for src/main/java in the file path.
 * Example: /workspace/sample-app/src/main/java/com/example/Demo.java
 *       -> /workspace/sample-app
 */
function findProjectRoot(filePath: string): string | null {
    const srcMainJava = path.sep + 'src' + path.sep + 'main' + path.sep + 'java';
    const idx = filePath.indexOf(srcMainJava);
    if (idx !== -1) {
        return filePath.substring(0, idx);
    }
    
    // Fallback: look for src directory
    const srcIdx = filePath.indexOf(path.sep + 'src' + path.sep);
    if (srcIdx !== -1) {
        return filePath.substring(0, srcIdx);
    }
    
    return null;
}

interface ProjectInfo {
    srcDir: string | null;  // Comma-separated for multi-module
    classesDir: string | null;  // Comma-separated for multi-module
    jarFile: string | null;
    dependencyDirs: string[] | null;  // Maven/Gradle dependency directories
    multiModuleRoot: string | null;  // Multi-module root if detected
    resolvedClasspath: string | null;  // Build-tool-resolved dependency JARs (comma-separated)
}

/**
 * Detect the project structure (Maven or Gradle).
 * Supports multi-module projects.
 */
async function detectProjectStructure(projectRoot: string, debug: boolean = false, workspaceBoundary?: string, allowImplicitMultiModule: boolean = true): Promise<ProjectInfo> {
    const result: ProjectInfo = {
        srcDir: null,
        classesDir: null,
        jarFile: null,
        dependencyDirs: null,
        multiModuleRoot: null,
        resolvedClasspath: null
    };

    // Check if this is a multi-module project
    const multiModuleRoot = findMultiModuleRoot(projectRoot, workspaceBoundary, allowImplicitMultiModule);
    result.multiModuleRoot = multiModuleRoot;
    
    if (multiModuleRoot) {
        // Multi-module project: collect all submodule sources and classes
        const modules = findSubModules(multiModuleRoot);
        
        // IMPORTANT: Always include the current project root if not already in the list
        // This ensures the project being analyzed is always included, even if detection logic
        // fails to find it (e.g., single Gradle project in a directory with sibling Maven projects)
        if (!modules.includes(projectRoot)) {
            modules.push(projectRoot);
        }
        
        if (debug) {
            log('[Java Call Hierarchy] Multi-module root: ' + multiModuleRoot);
            log('[Java Call Hierarchy] Detected modules: ' + modules.join(', '));
        }
        
        const srcDirs: string[] = [];
        const classesDirs: string[] = [];
        const depDirs: string[] = [];
        
        for (const modulePath of modules) {
            const srcPath = path.join(modulePath, 'src', 'main', 'java');
            if (fs.existsSync(srcPath)) {
                srcDirs.push(srcPath);
                if (debug) {
                    log('[Java Call Hierarchy]   Found src: ' + srcPath);
                }
            }
            
            // Gradle classes
            const gradleClasses = path.join(modulePath, 'build', 'classes', 'java', 'main');
            if (fs.existsSync(gradleClasses)) {
                classesDirs.push(gradleClasses);
                if (debug) {
                    log('[Java Call Hierarchy]   Found classes (Gradle): ' + gradleClasses);
                }
            }
            
            // Maven classes
            const mavenClasses = path.join(modulePath, 'target', 'classes');
            if (fs.existsSync(mavenClasses)) {
                classesDirs.push(mavenClasses);
                if (debug) {
                    log('[Java Call Hierarchy]   Found classes (Maven): ' + mavenClasses);
                }
            }
            
            // Maven dependency directory
            const mavenDeps = path.join(modulePath, 'target', 'dependency');
            if (fs.existsSync(mavenDeps)) {
                depDirs.push(mavenDeps);
            }
        }
        
        if (srcDirs.length > 0) {
            result.srcDir = srcDirs.join(',');
        }
        if (classesDirs.length > 0) {
            result.classesDir = classesDirs.join(',');
        }
        
        // Also collect dependency directories from multi-module root
        result.dependencyDirs = collectDependencyDirs(multiModuleRoot, depDirs);
    } else {
        // Single module project
        const srcPaths = [
            path.join(projectRoot, 'src', 'main', 'java'),
            path.join(projectRoot, 'src')
        ];

        for (const srcPath of srcPaths) {
            if (fs.existsSync(srcPath)) {
                result.srcDir = srcPath;
                break;
            }
        }

        // Check for compiled classes (Gradle or Maven)
        const classesPaths = [
            path.join(projectRoot, 'build', 'classes', 'java', 'main'), // Gradle
            path.join(projectRoot, 'target', 'classes') // Maven
        ];

        for (const classesPath of classesPaths) {
            if (fs.existsSync(classesPath)) {
                result.classesDir = classesPath;
                break;
            }
        }
        
        // Collect dependency directories for single module
        result.dependencyDirs = collectDependencyDirs(projectRoot, []);
    }

    // Find JAR file for classpath (search in multi-module root or project root)
    const searchRoot = multiModuleRoot || projectRoot;
    const jarDirs = [
        path.join(searchRoot, 'build', 'libs'), // Gradle
        path.join(searchRoot, 'target'), // Maven
        path.join(projectRoot, 'build', 'libs'), // Submodule Gradle
        path.join(projectRoot, 'target') // Submodule Maven
    ];

    for (const jarDir of jarDirs) {
        if (fs.existsSync(jarDir)) {
            const files = fs.readdirSync(jarDir);
            // Find the largest JAR that's not a plain/sources JAR
            let largestJar: { path: string; size: number } | null = null;
            
            for (const file of files) {
                if (file.endsWith('.jar') && 
                    !file.includes('-plain') && 
                    !file.includes('-sources') &&
                    !file.includes('-javadoc')) {
                    const fullPath = path.join(jarDir, file);
                    const stats = fs.statSync(fullPath);
                    if (!largestJar || stats.size > largestJar.size) {
                        largestJar = { path: fullPath, size: stats.size };
                    }
                }
            }
            
            if (largestJar) {
                result.jarFile = largestJar.path;
                break;
            }
        }
    }

    // Resolve dependency classpath via build tool (Maven/Gradle)
    result.resolvedClasspath = await resolveBuildToolClasspath(projectRoot, result.multiModuleRoot, debug);

    return result;
}

/**
 * Find the root of a multi-module project by looking for settings.gradle or pom.xml with modules.
 * @param workspaceBoundary If provided, do not traverse above this directory.
 * @param allowImplicitMultiModule If false, do not treat parent with sibling projects as multi-module root.
 */
function findMultiModuleRoot(startPath: string, workspaceBoundary?: string, allowImplicitMultiModule: boolean = true): string | null {
    let current = startPath;
    const root = path.parse(current).root;
    const boundary = workspaceBoundary ? path.normalize(workspaceBoundary) : null;
    
    // Implicit multi-module: only check the immediate parent of startPath.
    // Climbing further would match unrelated projects (e.g. /workspace/app when
    // the project is deep under /workspace/issue/.../java-src).
    if (allowImplicitMultiModule) {
        const parentDir = path.dirname(startPath);
        if (parentDir !== startPath) {
            const normalizedParent = path.normalize(parentDir);
            const isAboveBoundary = boundary && !normalizedParent.startsWith(boundary);
            if (!isAboveBoundary) {
                const siblings = countBuildSiblings(parentDir, startPath);
                if (siblings >= 1) {
                    return parentDir;
                }
            }
        }
    }

    while (current !== root) {
        // Check for Gradle multi-module (settings.gradle with 'include')
        const settingsGradle = path.join(current, 'settings.gradle');
        const settingsGradleKts = path.join(current, 'settings.gradle.kts');
        
        for (const settingsFile of [settingsGradle, settingsGradleKts]) {
            if (fs.existsSync(settingsFile)) {
                const content = fs.readFileSync(settingsFile, 'utf-8');
                if (content.includes('include')) {
                    return current;
                }
            }
        }
        
        // Check for Maven multi-module (pom.xml with <modules>)
        const pomXml = path.join(current, 'pom.xml');
        if (fs.existsSync(pomXml)) {
            const content = fs.readFileSync(pomXml, 'utf-8');
            if (content.includes('<modules>')) {
                return current;
            }
        }
        
        if (boundary && path.normalize(current) === boundary) {
            break;
        }
        
        current = path.dirname(current);
    }
    
    return null;
}

/**
 * Count sibling directories that have pom.xml or build.gradle (Maven or Gradle).
 */
function countBuildSiblings(parentDir: string, excludePath: string): number {
    try {
        const entries = fs.readdirSync(parentDir, { withFileTypes: true });
        let count = 0;
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const siblingPath = path.join(parentDir, entry.name);
                if (siblingPath !== excludePath) {
                    const hasPom = fs.existsSync(path.join(siblingPath, 'pom.xml'));
                    const hasGradle = fs.existsSync(path.join(siblingPath, 'build.gradle')) ||
                        fs.existsSync(path.join(siblingPath, 'build.gradle.kts'));
                    if (hasPom || hasGradle) {
                        // Skip non-Java siblings (e.g. migration, config modules) —
                        // they don't disqualify the parent as a multi-module root.
                        const hasSrc = fs.existsSync(path.join(siblingPath, 'src', 'main', 'java'));
                        if (!hasSrc) {
                            continue;
                        }
                        count++;
                    }
                }
            }
        }
        return count;
    } catch {
        return 0;
    }
}

/**
 * Find all submodule paths in a multi-module project.
 */
function findSubModules(multiModuleRoot: string): string[] {
    const modules: string[] = [];
    
    // Try Gradle settings.gradle
    const settingsGradle = path.join(multiModuleRoot, 'settings.gradle');
    const settingsGradleKts = path.join(multiModuleRoot, 'settings.gradle.kts');
    
    for (const settingsFile of [settingsGradle, settingsGradleKts]) {
        if (fs.existsSync(settingsFile)) {
            const content = fs.readFileSync(settingsFile, 'utf-8');
            // Match include 'module-name' or include('module-name') or include ':module-name'
            const includeMatches = content.matchAll(/include\s*[('"][:']?([^'")\s]+)['")\s]/g);
            for (const match of includeMatches) {
                const moduleName = match[1].replace(/^:/, '');
                const modulePath = path.join(multiModuleRoot, moduleName);
                if (fs.existsSync(modulePath)) {
                    modules.push(modulePath);
                }
            }
        }
    }
    
    // Try Maven pom.xml with <modules>
    const pomXml = path.join(multiModuleRoot, 'pom.xml');
    if (fs.existsSync(pomXml) && modules.length === 0) {
        const content = fs.readFileSync(pomXml, 'utf-8');
        const moduleMatches = content.matchAll(/<module>([^<]+)<\/module>/g);
        for (const match of moduleMatches) {
            const modulePath = path.join(multiModuleRoot, match[1]);
            if (fs.existsSync(modulePath)) {
                modules.push(modulePath);
            }
        }
    }
    
    // If no modules found via pom.xml <modules>, scan for directories with pom.xml or build.gradle
    if (modules.length === 0) {
        try {
            const entries = fs.readdirSync(multiModuleRoot, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const modulePath = path.join(multiModuleRoot, entry.name);
                    const modulePom = path.join(modulePath, 'pom.xml');
                    const moduleBuildGradle = path.join(modulePath, 'build.gradle');
                    const moduleBuildGradleKts = path.join(modulePath, 'build.gradle.kts');
                    const moduleSrc = path.join(modulePath, 'src', 'main', 'java');
                    // Include if it has (pom.xml or build.gradle) and src/main/java
                    const hasBuildFile = fs.existsSync(modulePom) || 
                                         fs.existsSync(moduleBuildGradle) || 
                                         fs.existsSync(moduleBuildGradleKts);
                    if (hasBuildFile && fs.existsSync(moduleSrc)) {
                        modules.push(modulePath);
                    }
                }
            }
        } catch {
            // Ignore errors
        }
    }
    
    // Also include the root if it has src/main/java
    const rootSrc = path.join(multiModuleRoot, 'src', 'main', 'java');
    if (fs.existsSync(rootSrc)) {
        modules.unshift(multiModuleRoot);
    }
    
    return modules;
}

/**
 * Collect dependency directories for classpath resolution.
 * Searches for Maven repository cache, Gradle cache, and local dependency directories.
 */
export function collectDependencyDirs(projectRoot: string, existingDirs: string[]): string[] {
    const depDirs = [...existingDirs];
    
    // Maven dependency directory (if mvn dependency:copy-dependencies was run)
    const mavenDeps = path.join(projectRoot, 'target', 'dependency');
    if (fs.existsSync(mavenDeps) && !depDirs.includes(mavenDeps)) {
        depDirs.push(mavenDeps);
    }
    
    // Gradle libs directory
    const gradleLibs = path.join(projectRoot, 'build', 'libs');
    if (fs.existsSync(gradleLibs) && !depDirs.includes(gradleLibs)) {
        depDirs.push(gradleLibs);
    }
    
    // Check for lib directory (common for some projects)
    const libDir = path.join(projectRoot, 'lib');
    if (fs.existsSync(libDir) && !depDirs.includes(libDir)) {
        depDirs.push(libDir);
    }
    
    // Check for libs directory
    const libsDir = path.join(projectRoot, 'libs');
    if (fs.existsSync(libsDir) && !depDirs.includes(libsDir)) {
        depDirs.push(libsDir);
    }
    
    return depDirs;
}

// ─── Build-tool classpath resolution ────────────────────────────────────────

interface ClasspathCacheEntry {
    classpath: string;
    mtime: number;
}

// In-memory cache keyed by projectRoot
const classpathCache = new Map<string, ClasspathCacheEntry>();

/**
 * Find the wrapper script (mvnw/gradlew) for a project.
 * Searches projectRoot → multiModuleRoot in order, then falls back to global commands.
 */
function findBuildToolExecutable(projectRoot: string, multiModuleRoot: string | null): {
    maven: string | null;
    gradle: string | null;
} {
    const isWindows = process.platform === 'win32';
    const searchDirs = [projectRoot, multiModuleRoot].filter((d): d is string => !!d);

    for (const dir of searchDirs) {
        const mvnw  = path.join(dir, isWindows ? 'mvnw.cmd'   : 'mvnw');
        const gradlew = path.join(dir, isWindows ? 'gradlew.bat' : 'gradlew');
        const hasMvnw    = fs.existsSync(mvnw);
        const hasGradlew = fs.existsSync(gradlew);
        if (hasMvnw || hasGradlew) {
            return {
                maven:  hasMvnw    ? mvnw    : null,
                gradle: hasGradlew ? gradlew : null
            };
        }
    }

    // Fall back to globally installed commands
    return { maven: 'mvn', gradle: 'gradle' };
}

/**
 * Run a command and return its stdout. Rejects on non-zero exit or timeout (10 s).
 */
function execCommand(cmd: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { cwd, shell: false });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`Command timed out after 10 s: ${cmd} ${args.join(' ')}`));
        }, 10000);

        child.on('close', (code: number) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(`Exit ${code}: ${stderr.trim().slice(0, 200)}`));
            }
        });
        child.on('error', (err: Error) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/**
 * Resolve the compile-scope dependency classpath by invoking Maven or Gradle.
 * Results are cached per projectRoot, invalidated when pom.xml / build.gradle mtime changes.
 * Returns a comma-separated list of JAR paths, or null on failure.
 */
export async function resolveBuildToolClasspath(
    projectRoot: string,
    multiModuleRoot: string | null,
    debug: boolean = false
): Promise<string | null> {
    const pomFile   = path.join(projectRoot, 'pom.xml');
    const gradleFile = fs.existsSync(path.join(projectRoot, 'build.gradle'))
        ? path.join(projectRoot, 'build.gradle')
        : path.join(projectRoot, 'build.gradle.kts');

    const hasMaven  = fs.existsSync(pomFile);
    const hasGradle = fs.existsSync(gradleFile);

    if (!hasMaven && !hasGradle) {
        return null;
    }

    // Check mtime-based cache
    const buildFile = hasMaven ? pomFile : gradleFile;
    let mtime = 0;
    try {
        mtime = fs.statSync(buildFile).mtimeMs;
    } catch {
        // ignore
    }
    const cached = classpathCache.get(projectRoot);
    if (cached && cached.mtime === mtime) {
        if (debug) { log(`[resolveBuildToolClasspath] cache hit for ${projectRoot}`); }
        return cached.classpath;
    }

    const executables = findBuildToolExecutable(projectRoot, multiModuleRoot);

    try {
        let classpath: string;

        if (hasMaven && executables.maven) {
            if (debug) { log(`[resolveBuildToolClasspath] Maven: ${executables.maven} -f ${pomFile}`); }
            // Use a temp file to avoid /dev/stdout issues in some environments
            const cpTmpFile = path.join(os.tmpdir(), `callcanvas-cp-${Date.now()}.txt`);
            try {
                await execCommand(
                    executables.maven,
                    ['-f', pomFile, 'dependency:build-classpath', '-DincludeScope=compile', '-q',
                     `-Dmdep.outputFile=${cpTmpFile}`],
                    projectRoot
                );
                const raw = fs.readFileSync(cpTmpFile, 'utf-8').trim();
                // Convert OS path separator to comma
                classpath = raw.split(path.delimiter).filter(Boolean).join(',');
            } finally {
                try { fs.unlinkSync(cpTmpFile); } catch { /* ignore */ }
            }
        } else if (hasGradle && executables.gradle) {
            if (debug) { log(`[resolveBuildToolClasspath] Gradle: ${executables.gradle} ${gradleFile}`); }
            // Write a temporary init script
            const initScript = path.join(os.tmpdir(), 'callcanvas-cp.gradle');
            fs.writeFileSync(initScript,
                `allprojects {\n` +
                `    task('printCompileClasspath') {\n` +
                `        doLast {\n` +
                `            def cp = configurations.findByName('compileClasspath')\n` +
                `            if (cp) { cp.files.each { println it } }\n` +
                `        }\n` +
                `    }\n` +
                `}\n`
            );
            const out = await execCommand(
                executables.gradle,
                ['-q', '--init-script', initScript, 'printCompileClasspath', '--project-dir', projectRoot],
                projectRoot
            );
            classpath = out.split('\n').map(l => l.trim()).filter(l => l.endsWith('.jar')).join(',');
        } else {
            return null;
        }

        if (!classpath) {
            return null;
        }

        classpathCache.set(projectRoot, { classpath, mtime });
        if (debug) { log(`[resolveBuildToolClasspath] resolved ${classpath.split(',').length} JARs`); }
        return classpath;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[resolveBuildToolClasspath] failed (will skip): ${msg}`);
        return null;
    }
}

// ─── End build-tool classpath resolution ─────────────────────────────────────

interface ExecuteResult {
    stdout: string;
    stderr: string;
}

/**
 * Execute the JAR file and return stdout and stderr.
 */
function executeJar(javaExe: string, args: string[], cwd: string, debug: boolean = false): Promise<ExecuteResult> {
    return new Promise((resolve, reject) => {
        const process = spawn(javaExe, args, { cwd });

        let stdout = '';
        let stderr = '';

        process.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        process.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        process.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                // Check for common errors
                let errorMessage: string;
                if (stderr.includes('UnsupportedClassVersionError')) {
                    errorMessage = 'Java 21 or higher is required';
                } else if (stderr.includes('root not found')) {
                    errorMessage = 'Method not found. Check the method signature.';
                } else if (stderr.includes('unknown tree')) {
                    errorMessage = 'Parse error: unknown tree. Try setting a different language level in javaCallHierarchy.languageLevel (e.g., JAVA_8 for older projects, JAVA_25 for the newest syntax). Enable debug mode for more details.';
                } else {
                    errorMessage = stderr || `Process exited with code ${code}`;
                }
                
                // In debug mode, include the full stderr
                if (debug && stderr) {
                    errorMessage += '\n\nFull debug output:\n' + stderr;
                }
                
                reject(new Error(errorMessage));
            }
        });

        process.on('error', (err) => {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                reject(new Error(`Java not found. Please install Java 21+ or set javaCallHierarchy.javaPath`));
            } else {
                reject(err);
            }
        });
    });
}

/**
 * Parse the JSON output from the analyzer.
 * The analyzer outputs a calls-method.json file.
 */
function parseAnalyzerOutput(output: string): CallHierarchyData | null {
    try {
        // Find the output directory from "Wrote: <path>" in stdout
        const wroteMatch = output.match(/Wrote:\s*(.+)/);
        if (wroteMatch) {
            const outputDir = wroteMatch[1].trim();
            const jsonFile = path.join(outputDir, 'calls-method.json');
            if (fs.existsSync(jsonFile)) {
                const content = fs.readFileSync(jsonFile, 'utf-8');
                const json = JSON.parse(content);
                return transformToCallHierarchy(json);
            }
        }

        return null;
    } catch (error) {
        console.error('Failed to parse output:', error);
        return null;
    }
}

/**
 * Transform the analyzer's JSON format to our internal format.
 * JSON structure: { nodes: [...], links: [...], unresolved: [...] }
 */
function transformToCallHierarchy(json: any): CallHierarchyData {
    const nodes = json.nodes || [];
    const links = json.links || json.edges || [];

    if (nodes.length === 0) {
        return {
            root: {
                method: 'Unknown',
                shortName: 'Unknown',
                calls: []
            }
        };
    }

    // Create node map
    const nodeMap = new Map<string, MethodNode>();
    for (const node of nodes) {
        const id = node.id;
        nodeMap.set(id, {
            method: id,
            shortName: node.display || extractShortName(id),
            line: node.line_start,
            file: node.file !== '-' ? node.file : undefined,
            calls: []
        });
    }

    // Build edges and track incoming edges
    const hasIncoming = new Set<string>();
    for (const link of links) {
        const fromNode = nodeMap.get(link.from);
        const toId = link.to;
        const toNode = nodeMap.get(toId);
        
        if (fromNode && toNode) {
            // Avoid duplicate calls
            if (!fromNode.calls.some(c => c.method === toNode.method)) {
                fromNode.calls.push(toNode);
            }
            hasIncoming.add(toId);
        }
    }

    // Find root (first node, or node with no incoming edges)
    let root: MethodNode | undefined;
    for (const [id, node] of nodeMap) {
        if (!hasIncoming.has(id)) {
            root = node;
            break;
        }
    }

    // Fallback to first node
    if (!root && nodes.length > 0) {
        root = nodeMap.get(nodes[0].id);
    }

    return {
        root: root || {
            method: 'Unknown',
            shortName: 'Unknown',
            calls: []
        }
    };
}

/**
 * Extract short method name from full signature.
 * Example: "com.example.MyClass#myMethod(String)" -> "MyClass.myMethod()"
 */
function extractShortName(fullMethod: string): string {
    // Handle format: package.ClassName#methodName(params)
    const match = fullMethod.match(/(?:[\w.]+\.)?(\w+)#(\w+)\([^)]*\)/);
    if (match) {
        return `${match[1]}.${match[2]}()`;
    }
    
    // Handle format: package.ClassName.methodName
    const dotMatch = fullMethod.match(/(?:[\w.]+\.)?(\w+)\.(\w+)$/);
    if (dotMatch) {
        return `${dotMatch[1]}.${dotMatch[2]}()`;
    }

    return fullMethod;
}

