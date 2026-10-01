import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { log, logError, showDebugOutput } from './logger';
import { analyzeNextLevelJS, reanalyzeRootJS } from './jsAnalyzer';
import { analyzeNextLevelTS, reanalyzeRootTS } from './tsAnalyzer';
import { analyzeNextLevelJava, analyzeIncomingCallsJava, reanalyzeRootJava } from './javaAnalyzer';
import { extractMethodName, detectAnalysisLanguage } from './methodExtractor';
import {
    buildReanalysisPlan,
    pickRootWindow,
    preserveLineComments,
    readAnalysisRecord,
    summarizeReanalysis,
    withAnalysisMetadata
} from './reanalysis';
import { perfSection, perfTotal, isPerfLogEnabled } from './perfLogger';
import { getCommitChanges, getWorkbenchChanges, showCommitHashInput } from './gitUtils';
import { openFileAtLine } from './fileNavigator';
import { isChangeSetCanvas } from './changeSet';
import { openChangeSet } from './changeSetCommand';
import { parseJacocoCoverage } from './coverageParser';

export function activate(context: vscode.ExtensionContext) {
    console.log('CallCanvas Viewer extension is now active');

    // Track active viewer panel and JSON file path
    let activePanel: vscode.WebviewPanel | undefined;
    let activeJsonPath: vscode.Uri | undefined;

    // Shared function to open viewer with a JSON file
    async function openViewerWithJsonPath(jsonPath: vscode.Uri, context: vscode.ExtensionContext) {
        // Read JSON file
        let jsonData;
        let rawJsonContent: string | undefined;
        try {
            rawJsonContent = fs.readFileSync(jsonPath.fsPath, 'utf8').trim();

            // If file is empty or only whitespace, use default structure
            if (!rawJsonContent) {
                jsonData = {
                    autoLayout: true,
                    windows: [],
                    connections: []
                };
            } else {
                jsonData = JSON.parse(rawJsonContent);

                // Ensure required fields exist
                if (!jsonData.windows) {
                    jsonData.windows = [];
                }
                if (!jsonData.connections) {
                    jsonData.connections = [];
                }
                if (jsonData.autoLayout === undefined) {
                    jsonData.autoLayout = true;
                }
            }
        } catch (error) {
            // If JSON parsing fails, try to start with default structure
            vscode.window.showWarningMessage(`JSON parse error, starting with empty structure: ${error}`);
            rawJsonContent = undefined;
            jsonData = {
                autoLayout: true,
                windows: [],
                connections: []
            };
        }

        // 初回ロード時に .bak を作成（有効な JSON の場合のみ）— 最初の読み込み結果を再利用
        try {
            if (rawJsonContent && validateCallCanvasSchema(jsonData) === null) {
                fs.writeFileSync(jsonPath.fsPath + '.bak', rawJsonContent, 'utf8');
            }
        } catch { /* 無視 */ }

        // Create and show webview panel
        const initialTitle = (jsonData.windows?.[0]?.displayName)
            ? jsonData.windows[0].displayName.replace(/\s*#\s*/g, '#')
            : 'CallCanvas Viewer';
        const panel = vscode.window.createWebviewPanel(
            'callcanvasViewer',
            initialTitle,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
            }
        );
        panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'callcanvas-icon.svg');

        // Store active panel and JSON path (use captured jsonPath for this panel's save/open)
        activePanel = panel;
        activeJsonPath = jsonPath;
        const panelJsonPath = jsonPath;

        // Set webview HTML content
        panel.webview.html = getWebviewContent(jsonData, false, panel.webview, context.extensionUri, panelJsonPath.fsPath);

        // Clean up when panel is disposed
        panel.onDidDispose(() => {
            activePanel = undefined;
            activeJsonPath = undefined;
        });

        // Handle messages from webview
        panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'openFile':
                        await openFileAtLine(message.filePath, message.line);
                        break;
                    case 'openJsonFile':
                        if (panelJsonPath) {
                            const doc = await vscode.workspace.openTextDocument(panelJsonPath);
                            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
                        } else {
                            vscode.window.showWarningMessage('開いているJSONファイルがありません。');
                        }
                        break;
                    case 'saveData':
                        if (panelJsonPath) {
                            try {
                                const jsonString = JSON.stringify(message.data, null, 2);
                                fs.writeFileSync(panelJsonPath.fsPath, jsonString, 'utf8');
                                vscode.window.showInformationMessage('CallCanvas data saved successfully');
                            } catch (error) {
                                vscode.window.showErrorMessage(`Failed to save data: ${error}`);
                            }
                        }
                        if (message.data?.windows?.[0]?.displayName) {
                            panel.title = message.data.windows[0].displayName.replace(/\s*#\s*/g, '#');
                        }
                        break;
                    case 'exportHtml': {
                        const html = getWebviewContent(message.data, true);
                        const defaultName = panelJsonPath
                            ? path.basename(panelJsonPath.fsPath, '.json') + '.html'
                            : 'callcanvas-export.html';
                        const defaultDir = panelJsonPath
                            ? path.dirname(panelJsonPath.fsPath)
                            : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '');
                        const saveUri = await vscode.window.showSaveDialog({
                            defaultUri: vscode.Uri.file(path.join(defaultDir, defaultName)),
                            filters: { 'HTML Files': ['html'] }
                        });
                        if (saveUri) {
                            try {
                                fs.writeFileSync(saveUri.fsPath, html, 'utf8');
                                vscode.window.showInformationMessage(`HTML exported: ${saveUri.fsPath}`);
                            } catch (error) {
                                vscode.window.showErrorMessage(`Failed to export HTML: ${error}`);
                            }
                        }
                        break;
                    }
                    case 'analyzeNextLevel':
                        await analyzeNextLevel(message.windowData, panel, context, panelJsonPath);
                        break;
                    case 'analyzeIncomingCalls':
                        await analyzeIncomingCalls(message.windowData, panel, context, panelJsonPath);
                        break;
                    case 'analyzeToRoot':
                        await analyzeToRoot(message.windowData, panel, context, panelJsonPath);
                        break;
                    case 'reanalyzeRoot':
                        await reanalyzeRootMethod(panel, context, panelJsonPath);
                        break;
                    case 'getCommitChanges':
                        await getCommitChanges(message.commitHash, panel);
                        break;
                    case 'getWorkbenchChanges':
                        await getWorkbenchChanges(panel);
                        break;
                    case 'showCommitInputDialog':
                        const commitHash = await showCommitHashInput();
                        if (commitHash) {
                            await getCommitChanges(commitHash, panel);
                        }
                        break;
                    case 'showWidthInputDialog':
                        const currentWidth = message.currentWidth || 300;
                        const widthInput = await vscode.window.showInputBox({
                            prompt: 'ウィンドウの幅を入力してください',
                            placeHolder: '200〜1200の範囲で指定',
                            value: currentWidth.toString(),
                            validateInput: (value) => {
                                const width = parseInt(value, 10);
                                if (isNaN(width)) {
                                    return '数値を入力してください';
                                }
                                if (width < 200 || width > 1200) {
                                    return '幅は200〜1200の範囲で指定してください';
                                }
                                return null;
                            }
                        });
                        if (widthInput) {
                            panel.webview.postMessage({
                                command: 'applyWidth',
                                width: parseInt(widthInput, 10)
                            });
                        }
                        break;
                    case 'loadCoverageReport':
                        await loadCoverageReportForPanel(panel);
                        break;
                    case 'clearCoverage':
                        panel.webview.postMessage({ command: 'clearCoverage' });
                        break;
                }
            },
            undefined,
            context.subscriptions
        );
    }

    // Command: callcanvas.openViewer (interactive file picker)
    let disposable = vscode.commands.registerCommand('callcanvas.openViewer', async () => {
        // Get the active editor's document
        const activeEditor = vscode.window.activeTextEditor;
        let jsonPath: vscode.Uri | undefined;

        if (activeEditor && activeEditor.document.fileName.endsWith('.json')) {
            jsonPath = activeEditor.document.uri;
        } else {
            // Show file picker
            const fileUri = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'JSON Files': ['json']
                },
                title: 'Select CallCanvas JSON File'
            });

            if (fileUri && fileUri[0]) {
                jsonPath = fileUri[0];
            }
        }

        if (!jsonPath) {
            vscode.window.showErrorMessage('No JSON file selected');
            return;
        }

        await openViewerWithJsonPath(jsonPath, context);
    });

    // Command: callcanvas.openViewerWithFile (programmatic with file path argument)
    let disposableWithFile = vscode.commands.registerCommand(
        'callcanvas.openViewerWithFile',
        async (fileUri?: vscode.Uri | string) => {
            let jsonPath: vscode.Uri | undefined;

            if (fileUri) {
                // Convert string path to Uri if needed
                if (typeof fileUri === 'string') {
                    // Check if it's an absolute path
                    if (path.isAbsolute(fileUri)) {
                        jsonPath = vscode.Uri.file(fileUri);
                    } else {
                        // Relative path - resolve from workspace
                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        if (workspaceFolders && workspaceFolders.length > 0) {
                            const workspaceRoot = workspaceFolders[0].uri.fsPath;
                            const absolutePath = path.join(workspaceRoot, fileUri);
                            jsonPath = vscode.Uri.file(absolutePath);
                        } else {
                            vscode.window.showErrorMessage('No workspace folder open');
                            return;
                        }
                    }
                } else {
                    jsonPath = fileUri;
                }
            }

            if (!jsonPath) {
                vscode.window.showErrorMessage('No file path provided');
                return;
            }

            // Check if file exists
            if (!fs.existsSync(jsonPath.fsPath)) {
                vscode.window.showErrorMessage(`File not found: ${jsonPath.fsPath}`);
                return;
            }

            await openViewerWithJsonPath(jsonPath, context);
        }
    );

    // Command: callcanvas.createNewViewer (create new CallCanvas JSON and open viewer)
    let disposableCreateNew = vscode.commands.registerCommand('callcanvas.createNewViewer', async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        // Ask for file name
        const fileName = await vscode.window.showInputBox({
            prompt: 'Enter name for new CallCanvas file',
            value: 'call-hierarchy.json',
            placeHolder: 'call-hierarchy.json'
        });

        if (!fileName) {
            return;
        }

        // Create the file path
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const filePath = path.join(workspaceRoot, fileName);
        const fileUri = vscode.Uri.file(filePath);

        // Check if file already exists
        if (fs.existsSync(filePath)) {
            const overwrite = await vscode.window.showWarningMessage(
                `File ${fileName} already exists. Open it?`,
                'Yes', 'No'
            );
            if (overwrite === 'Yes') {
                await openViewerWithJsonPath(fileUri, context);
            }
            return;
        }

        // Create empty JSON file with default structure
        const defaultContent = JSON.stringify({
            autoLayout: true,
            windows: [],
            connections: []
        }, null, 2);

        try {
            fs.writeFileSync(filePath, defaultContent, 'utf8');
            vscode.window.showInformationMessage(`Created ${fileName}`);
            
            // Open the viewer
            await openViewerWithJsonPath(fileUri, context);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create file: ${error}`);
        }
    });

    // Command: callcanvas.addMethodToViewer (add selected code to active viewer)
    let disposableAddMethod = vscode.commands.registerCommand('callcanvas.addMethodToViewer', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        if (!activePanel) {
            vscode.window.showErrorMessage('No active CallCanvas viewer. Please open a CallCanvas viewer first.');
            return;
        }

        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);
        
        if (!selectedText) {
            vscode.window.showErrorMessage('No code selected');
            return;
        }

        // Get file path relative to workspace
        const workspaceFolders = vscode.workspace.workspaceFolders;
        let relativePath = editor.document.fileName;
        
        if (workspaceFolders && workspaceFolders.length > 0) {
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            if (editor.document.fileName.startsWith(workspaceRoot)) {
                relativePath = path.relative(workspaceRoot, editor.document.fileName);
            }
        }
        relativePath = relativePath.split('\\').join('/');

        // Get start line (1-based)
        const startLine = selection.start.line + 1;

        // Generate unique window ID
        const windowId = 'window-' + Date.now();

        // Extract class name from file path (e.g., "TodoController.java" -> "TodoController")
        const fileName = path.basename(editor.document.fileName);
        const className = fileName.replace(/\.[^.]+$/, ''); // Remove extension

        // Extract method/function name from selected code
        const methodName = extractMethodName(selectedText, editor.document.languageId);

        // Generate displayName in "ClassName # methodName" format
        const displayName = methodName ? `${className} # ${methodName}` : className;

        // Send message to webview (matching callcanvas.json format)
        activePanel.webview.postMessage({
            command: 'addWindow',
            window: {
                id: windowId,
                displayName: displayName,
                filePath: relativePath,
                startLine: startLine,
                code: selectedText,
                highlightLines: []
            }
        });

        vscode.window.showInformationMessage(`Added: ${displayName}`);
    });

    // Command: Jump back (Alt+←)
    let disposableJumpBack = vscode.commands.registerCommand('callcanvas.jumpBack', () => {
        if (activePanel) {
            activePanel.webview.postMessage({
                command: 'jumpBack'
            });
        }
    });

    // Command: Export to HTML
    let disposableExportHtml = vscode.commands.registerCommand('callcanvas.exportToHtml', () => {
        if (activePanel) {
            activePanel.webview.postMessage({ command: 'requestExportHtml' });
        } else {
            vscode.window.showWarningMessage('CallCanvas Viewer を開いてから実行してください');
        }
    });

    // Command: Load JaCoCo coverage report
    let disposableLoadCoverage = vscode.commands.registerCommand('callcanvas.loadCoverageReport', async () => {
        if (!activePanel) {
            vscode.window.showWarningMessage('CallCanvas Viewer を開いてから実行してください');
            return;
        }
        await loadCoverageReportForPanel(activePanel);
    });

    // Command: Clear coverage highlight
    let disposableClearCoverage = vscode.commands.registerCommand('callcanvas.clearCoverage', () => {
        if (activePanel) {
            activePanel.webview.postMessage({ command: 'clearCoverage' });
        }
    });

    // Command: Reload viewer from JSON on disk (manual refresh after file watch removal)
    let disposableReloadFromJson = vscode.commands.registerCommand('callcanvas.reloadFromJson', () => {
        if (!activePanel || !activeJsonPath) {
            vscode.window.showWarningMessage('CallCanvas Viewer を開いてから実行してください');
            return;
        }
        const result = loadCallCanvasJsonForReload(activeJsonPath.fsPath);
        if (!result.ok) {
            vscode.window.showErrorMessage(`CallCanvas: JSONの再読み込みに失敗しました。\n${result.message}`);
            return;
        }
        try {
            fs.writeFileSync(activeJsonPath.fsPath + '.bak', JSON.stringify(result.data, null, 2), 'utf8');
        } catch { /* 無視 */ }
        activePanel.webview.postMessage({
            command: 'reloadData',
            data: result.data,
            reloadSource: 'disk'
        });
        if (result.data?.windows?.[0]?.displayName) {
            activePanel.title = result.data.windows[0].displayName.replace(/\s*#\s*/g, '#');
        }
    });

    // Command: callcanvas.openChangeSet（コミットかワークベンチの変更を 1 枚の変更集合キャンバスにして開く）
    let disposableOpenChangeSet = vscode.commands.registerCommand('callcanvas.openChangeSet', async (target?: string) => {
        await openChangeSet((jsonPath) => openViewerWithJsonPath(jsonPath, context), target);
    });

    context.subscriptions.push(disposable);
    context.subscriptions.push(disposableWithFile);
    context.subscriptions.push(disposableCreateNew);
    context.subscriptions.push(disposableAddMethod);
    context.subscriptions.push(disposableJumpBack);
    context.subscriptions.push(disposableExportHtml);
    context.subscriptions.push(disposableLoadCoverage);
    context.subscriptions.push(disposableClearCoverage);
    context.subscriptions.push(disposableReloadFromJson);
    context.subscriptions.push(disposableOpenChangeSet);
}

async function loadCoverageReportForPanel(panel: vscode.WebviewPanel): Promise<void> {
    const fileUri = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'JaCoCo XML Report': ['xml'] },
        title: 'JaCoCo カバレッジレポート (jacoco.xml) を選択'
    });
    if (!fileUri || !fileUri[0]) {
        return;
    }
    try {
        const coverage = parseJacocoCoverage(fileUri[0].fsPath);
        // Convert Map structure to plain object for postMessage serialization
        const coverageObj: Record<string, Record<number, { mi: number; ci: number; mb: number; cb: number }>> = {};
        for (const [fileKey, lineMap] of coverage) {
            coverageObj[fileKey] = {};
            for (const [lineNr, data] of lineMap) {
                coverageObj[fileKey][lineNr] = data;
            }
        }
        panel.webview.postMessage({ command: 'applyCoverage', coverage: coverageObj });
        vscode.window.showInformationMessage(`カバレッジ読込完了: ${coverage.size} ファイル`);
    } catch (err) {
        vscode.window.showErrorMessage(`カバレッジ読込エラー: ${err}`);
    }
}


function getWebviewContent(jsonData: any, exportMode: boolean = false, webview?: vscode.Webview, extensionUri?: vscode.Uri, jsonFilePath?: string): string {
    // Embed the JSON data and create the HTML content
    const dataJson = JSON.stringify(jsonData).replace(/</g, '\\u003c');

    // Read settings from VSCode configuration
    const config = vscode.workspace.getConfiguration('callcanvas');
    const windowWidth = config.get<number>('windowWidth', 600);
    const minWindowHeight = config.get<number>('minWindowHeight', 80);
    const maxWindowHeight = config.get<number>('maxWindowHeight', 600);
    const jumpToCallTargetKey = config.get<string>('jumpToCallTargetKey', 'f12').toLowerCase().trim();

    // Build highlight.js script tag
    let hljsScriptTag = '';
    if (!exportMode && webview && extensionUri) {
        // Webview mode: load from media/ via asWebviewUri
        const hljsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'highlight.min.js'));
        hljsScriptTag = `    <script src="${hljsUri}"></script>`;
    } else if (exportMode) {
        // Export mode: inline the hljs bundle for self-contained HTML
        try {
            const hljsPath = path.join(__dirname, '..', 'media', 'highlight.min.js');
            const hljsSource = fs.readFileSync(hljsPath, 'utf8');
            hljsScriptTag = `    <script>${hljsSource}</script>`;
        } catch (e) {
            // If media file not found, skip hljs (fallback to existing highlighting)
            hljsScriptTag = '';
        }
    }

    let cspMetaTag: string;
    if (exportMode) {
        cspMetaTag = '';
    } else if (webview) {
        cspMetaTag = `    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'unsafe-inline' ${webview.cspSource};">`;
    } else {
        cspMetaTag = `    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">`;
    }

    // Build CSS tag: link in webview mode, inline in export mode
    let cssTag: string;
    if (!exportMode && webview && extensionUri) {
        const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'viewer.css'));
        cssTag = `    <link rel="stylesheet" href="${cssUri}">`;
    } else {
        try {
            const cssPath = path.join(__dirname, '..', 'media', 'viewer.css');
            cssTag = `    <style>\n${fs.readFileSync(cssPath, 'utf8')}\n    </style>`;
        } catch (e) {
            cssTag = '';
        }
    }

    // Build viewer script tag
    let viewerScript: string;
    if (!exportMode && webview && extensionUri) {
        const viewerScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'viewer.js'));
        viewerScript = `    <script src="${viewerScriptUri}"></script>`;
    } else {
        try {
            const jsPath = path.join(__dirname, '..', 'media', 'viewer.js');
            viewerScript = `    <script>\n${fs.readFileSync(jsPath, 'utf8')}\n    </script>`;
        } catch (e) {
            viewerScript = '';
        }
    }

    return `<!DOCTYPE html>
<html lang="ja">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
${cspMetaTag}
    <title>CallCanvas Code Navigation Viewer</title>
${cssTag}
${hljsScriptTag}
    <script>
        window.CALLCANVAS_CONFIG = {
            IS_EXPORT_MODE: ${exportMode},
            SETTINGS: {
                windowWidth: ${windowWidth},
                minWindowHeight: ${minWindowHeight},
                maxWindowHeight: ${maxWindowHeight},
                jumpToCallTargetKey: ${JSON.stringify(jumpToCallTargetKey)}
            },
            initialData: ${dataJson},
            jsonFilePath: ${JSON.stringify(jsonFilePath || '')}
        };
    </script>
${viewerScript}
</head>

<body data-viewer-script="0.1.79">
    <!-- Toast notification container -->
    <div id="toast-container" class="toast-container"></div>
    <!-- Container will be populated dynamically by JavaScript -->
    <div class="container"></div>
</body>

</html>`;
}


/**
 * Analyze the next level of call hierarchy for a selected window
 */
async function analyzeNextLevel(
    windowData: { id?: string; displayName: string; filePath: string; code: string; startLine: number },
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    activeJsonPath?: vscode.Uri
): Promise<void> {
    // Show debug output channel
    showDebugOutput();
    log('=== Starting analyzeNextLevel ===');
    log(`Input windowData:`);
    log(`  displayName: ${windowData.displayName}`);
    log(`  filePath: ${windowData.filePath}`);
    log(`  startLine: ${windowData.startLine}`);
    log(`  code length: ${windowData.code?.length || 0} chars`);
    log(`  code preview: ${windowData.code?.substring(0, 200)}...`);
    log(`  activeJsonPath: ${activeJsonPath?.fsPath || 'not set'}`);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        logError('No workspace folder open');
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    log(`Workspace root: ${workspaceRoot}`);

    // Language routing
    const lang = detectAnalysisLanguage(windowData.filePath);
    perfSection(`analyzeNextLevel (${lang || 'unknown'})`);
    if (lang === 'java') {
        await analyzeNextLevelJava(windowData, panel, context, activeJsonPath, workspaceRoot);
    } else if (lang === 'typescript') {
        await analyzeNextLevelTS(windowData, panel, context, activeJsonPath);
    } else if (lang === 'javascript') {
        await analyzeNextLevelJS(windowData, panel, context, activeJsonPath);
    } else {
        vscode.window.showWarningMessage('この言語の解析は未対応です');
    }
}

/**
 * Analyze incoming calls (callers) for a selected window
 */
async function analyzeIncomingCalls(
    windowData: { id?: string; displayName: string; filePath: string; code: string; startLine: number },
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    activeJsonPath?: vscode.Uri,
    depth: number = 1,
    progressTitle?: string
): Promise<void> {
    // Show debug output channel
    showDebugOutput();
    log('=== Starting analyzeIncomingCalls ===');
    log(`Input windowData:`);
    log(`  displayName: ${windowData.displayName}`);
    log(`  filePath: ${windowData.filePath}`);
    log(`  startLine: ${windowData.startLine}`);
    log(`  activeJsonPath: ${activeJsonPath?.fsPath || 'not set'}`);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        logError('No workspace folder open');
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    log(`Workspace root: ${workspaceRoot}`);

    // Language routing
    const lang = detectAnalysisLanguage(windowData.filePath);
    perfSection(`analyzeIncomingCalls (${lang || 'unknown'})`);
    if (lang === 'java') {
        await analyzeIncomingCallsJava(windowData, panel, context, activeJsonPath, workspaceRoot, depth, progressTitle);
    } else if (lang === 'javascript' || lang === 'typescript') {
        vscode.window.showInformationMessage('Incoming calls解析はJS/TSでは未対応です（将来対応予定）');
    } else {
        vscode.window.showWarningMessage('この言語の解析は未対応です');
    }
}

/**
 * Analyze incoming calls recursively to root (callers with no further callers)
 */
async function analyzeToRoot(
    windowData: { id?: string; displayName: string; filePath: string; code: string; startLine: number },
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    activeJsonPath?: vscode.Uri
): Promise<void> {
    showDebugOutput();
    log('=== Starting analyzeToRoot ===');
    log(`  displayName: ${windowData.displayName}`);
    log(`  filePath: ${windowData.filePath}`);
    log(`  startLine: ${windowData.startLine}`);

    // Java only — show clear message before delegating
    const lang = detectAnalysisLanguage(windowData.filePath);
    perfSection(`analyzeToRoot (${lang || 'unknown'})`);
    if (lang !== 'java') {
        vscode.window.showWarningMessage('ルートまで解析はJavaファイルのみ対応です');
        return;
    }

    // Delegate to analyzeIncomingCalls with depth=-1 (workspace check happens there)
    await analyzeIncomingCalls(windowData, panel, context, activeJsonPath, -1, `ルートまで解析中: ${windowData.displayName}`);
}

/**
 * Re-analyze the root method of the currently displayed CallCanvas JSON and reload the viewer.
 * Called when user clicks "ルート再解析" in the analyze menu.
 */
async function reanalyzeRootMethod(
    panel: vscode.WebviewPanel,
    _context: vscode.ExtensionContext,
    activeJsonPath: vscode.Uri | undefined
): Promise<void> {
    showDebugOutput();
    log('=== Starting reanalyzeRootMethod ===');
    perfSection('reanalyzeRootMethod');

    if (!activeJsonPath) {
        vscode.window.showErrorMessage('現在開いているCallCanvas JSONファイルがありません');
        return;
    }

    // Read current JSON to get root window info
    let currentJson: any;
    try {
        const content = fs.readFileSync(activeJsonPath.fsPath, 'utf-8');
        currentJson = JSON.parse(content);
    } catch (error) {
        vscode.window.showErrorMessage(`JSONファイルの読み込みに失敗しました: ${error}`);
        return;
    }

    if (isChangeSetCanvas(currentJson)) {
        vscode.window.showWarningMessage('変更集合キャンバスはルート再解析の対象外です（「CallCanvas: Open Change Set」で作り直してください）');
        return;
    }

    if (!currentJson.windows || currentJson.windows.length === 0) {
        vscode.window.showErrorMessage('ルートメソッドが見つかりません');
        return;
    }

    // Language decides which depth setting the plan falls back to, so resolve the
    // root window first (recorded id > graph entry > windows[0]).
    const record = readAnalysisRecord(currentJson);
    const probeRoot = pickRootWindow(currentJson.windows, currentJson.connections, record.rootWindowId);
    const langPath = record.rootFilePath || (probeRoot ? probeRoot.filePath : '');
    const lang = record.language || detectAnalysisLanguage(langPath);
    if (lang !== 'java' && lang !== 'typescript' && lang !== 'javascript') {
        vscode.window.showWarningMessage('この言語の再解析は未対応です');
        return;
    }

    const depthSection = lang === 'java'
        ? 'javaCallHierarchy'
        : (lang === 'typescript' ? 'tsCallHierarchy' : 'jsCallHierarchy');
    const configDepth = vscode.workspace.getConfiguration(depthSection).get<number>('depth', 5);

    const plan = buildReanalysisPlan(currentJson, { depth: configDepth });
    if (!plan || !plan.rootFilePath) {
        vscode.window.showErrorMessage('ルートメソッドが見つかりません');
        return;
    }
    log(`Reanalysis plan (${plan.source}): root=${plan.methodSignature || plan.rootClass || plan.rootWindow?.displayName}, `
        + `file=${plan.rootFilePath}, declLine=${plan.declLine}, direction=${plan.direction}, depth=${plan.depth}`);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    // Resolve absolute file path for the root (stored as relative in JSON)
    const absoluteFilePath = resolveAbsoluteFilePath(plan.rootFilePath, workspaceRoot, activeJsonPath.fsPath);
    log(`Resolved absolute file path: ${absoluteFilePath}`);

    const rootLabel = plan.rootClass || (plan.rootWindow ? plan.rootWindow.displayName : plan.methodSignature);
    const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `ルート再解析中: ${rootLabel}`,
        cancellable: false
    }, async () => {
        if (lang === 'java') {
            return reanalyzeRootJava(plan, absoluteFilePath);
        }
        if (lang === 'typescript') {
            return reanalyzeRootTS(plan, absoluteFilePath);
        }
        return reanalyzeRootJS(plan, absoluteFilePath, activeJsonPath);
    });

    // Never replace a working canvas with a failed/empty analysis.
    if (!result.success || !result.data) {
        logError(`Reanalysis failed: ${result.error}`);
        vscode.window.showErrorMessage(`再解析失敗: ${result.error || '不明なエラー'}（キャンバスは変更していません）`);
        return;
    }

    const summary = summarizeReanalysis(currentJson, result.data);
    const newData = withAnalysisMetadata(preserveLineComments(currentJson, result.data), {
        language: lang,
        root: plan.rootClass ? undefined : (result.signature || plan.methodSignature || undefined),
        rootClass: plan.rootClass || undefined,
        rootFilePath: plan.rootFilePath,
        direction: plan.direction,
        depth: plan.depth
    });

    const backupPath = backupJsonFile(activeJsonPath.fsPath);
    try {
        fs.writeFileSync(activeJsonPath.fsPath, JSON.stringify(newData, null, 2), 'utf8');
        log(`Saved re-analyzed data to: ${activeJsonPath.fsPath}`);
    } catch (saveError) {
        logError(`Failed to save JSON: ${saveError}`);
        vscode.window.showErrorMessage(`再解析結果の保存に失敗しました: ${saveError}`);
        return;
    }

    panel.webview.postMessage({
        command: 'reloadData',
        data: newData
    });

    const diff = (summary.added > 0 || summary.removed > 0)
        ? `（+${summary.added} / -${summary.removed}）`
        : '';
    const backupNote = backupPath ? ` バックアップ: ${path.basename(backupPath)}` : '';
    vscode.window.showInformationMessage(`再解析完了: ${summary.total} メソッド${diff}${backupNote}`);
    if (summary.removed > 0) {
        log(`${summary.removed} windows are not part of the recorded analysis `
            + '(added later via 次の階層/呼び出し元の解析) and were not reproduced.');
    }
}

/**
 * Copy the canvas JSON to `<name>.json.bak` before it is replaced, so a
 * re-analysis that returns a smaller graph than expected stays recoverable.
 */
function backupJsonFile(fsPath: string): string | null {
    try {
        const backupPath = fsPath + '.bak';
        fs.copyFileSync(fsPath, backupPath);
        return backupPath;
    } catch (error) {
        log(`Failed to create backup: ${error}`);
        return null;
    }
}

/**
 * Resolve a relative file path (as stored in CallCanvas JSON) to an absolute path.
 * Tries multiple candidate directories by traversing up from the JSON file's project root.
 * This handles multi-module projects where filePath is relative to the multi-module root.
 */
function resolveAbsoluteFilePath(filePath: string, workspaceRoot: string, jsonFsPath: string): string {
    if (path.isAbsolute(filePath)) {
        return filePath;
    }

    // Build list of candidate root directories to try, from innermost to outermost
    const candidateRoots: string[] = [];

    // Start from build/ parent (project root) and traverse up to workspace root
    let startDir: string;
    if (jsonFsPath.includes('/build/')) {
        const buildIndex = jsonFsPath.indexOf('/build/');
        startDir = jsonFsPath.substring(0, buildIndex);
    } else {
        startDir = path.dirname(jsonFsPath);
    }

    let currentDir = startDir;
    while (true) {
        candidateRoots.push(currentDir);
        if (currentDir === workspaceRoot || currentDir === path.dirname(currentDir)) {
            break;
        }
        currentDir = path.dirname(currentDir);
    }

    // Try each candidate root
    for (const root of candidateRoots) {
        const candidate = path.join(root, filePath);
        if (fs.existsSync(candidate)) {
            log(`Resolved ${filePath} -> ${candidate}`);
            return candidate;
        }
    }

    // Fallback: return as-is and let the API handle it
    log(`Warning: Could not resolve absolute path for ${filePath}, using as-is`);
    return filePath;
}


export function deactivate() { }

function validateCallCanvasSchema(data: any): string | null {
    if (typeof data !== 'object' || data === null) { return 'ルートがオブジェクトではありません'; }
    if (!Array.isArray(data.windows)) { return 'windows フィールドが配列ではありません'; }
    for (let i = 0; i < data.windows.length; i++) {
        const w = data.windows[i];
        if (typeof w.id !== 'string')          { return `windows[${i}].id が string ではありません`; }
        if (typeof w.displayName !== 'string') { return `windows[${i}].displayName が string ではありません`; }
        if (typeof w.code !== 'string')        { return `windows[${i}].code が string ではありません`; }
        if (w.position) {
            const p = w.position;
            if (['top', 'left', 'width', 'height'].some(k => typeof p[k] !== 'number')) {
                return `windows[${i}].position の数値フィールドが不正です`;
            }
        }
    }
    return null;
}

function loadCallCanvasJsonForReload(fsPath: string): { ok: true; data: any } | { ok: false; message: string } {
    let content: string;
    try {
        content = fs.readFileSync(fsPath, 'utf8').trim();
    } catch (e) {
        return { ok: false, message: `ファイルを読み込めません: ${e}` };
    }
    let data: any;
    try {
        data = content
            ? JSON.parse(content)
            : { autoLayout: true, windows: [], connections: [] };
    } catch (e) {
        return { ok: false, message: `JSON パースエラー: ${e}` };
    }
    const schemaError = validateCallCanvasSchema(data);
    if (schemaError) {
        return { ok: false, message: schemaError };
    }
    if (!data.windows) { data.windows = []; }
    if (!data.connections) { data.connections = []; }
    if (data.autoLayout === undefined) { data.autoLayout = true; }
    return { ok: true, data };
}

