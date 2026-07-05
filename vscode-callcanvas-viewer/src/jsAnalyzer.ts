import * as vscode from 'vscode';
import * as fs from 'fs';
import { log } from './logger';
import { extractMethodSignatureJS } from './methodExtractor';
import { isPerfLogEnabled, perfLog, perfTotal, emitJsTimingEntries } from './perfLogger';

/**
 * Read htmlPath from the metadata field of the active CallCanvas JSON file.
 * Returns undefined if not available (non-vanilla-JS, or file unreadable).
 */
export function getHtmlPathFromActiveJson(activeJsonPath: vscode.Uri): string | undefined {
    try {
        const content = fs.readFileSync(activeJsonPath.fsPath, 'utf-8');
        const json = JSON.parse(content);
        return json?.metadata?.htmlPath ?? undefined;
    } catch {
        return undefined;
    }
}


/**
 * Analyze next level for JavaScript/TypeScript files via JS Call Hierarchy extension API
 */
export async function analyzeNextLevelJS(
    windowData: { id?: string; displayName: string; filePath: string; code: string; startLine: number },
    panel: vscode.WebviewPanel,
    _context: vscode.ExtensionContext,
    activeJsonPath?: vscode.Uri
): Promise<void> {
    const perfEnabled = isPerfLogEnabled();
    const opName = 'analyzeNextLevel';
    let totalStart = 0;
    if (perfEnabled) { totalStart = Date.now(); }

    // 1. Resolve method signature via JS Call Hierarchy API
    let t0 = 0;
    if (perfEnabled) { t0 = Date.now(); }
    let methodSignature: string | null = null;
    try {
        methodSignature = await vscode.commands.executeCommand<string | null>(
            'jsCallHierarchy.resolveMethodSignature',
            windowData.filePath,
            windowData.startLine
        );
        if (methodSignature) {
            log(`Got method signature from JS Call Hierarchy API: ${methodSignature}`);
        }
    } catch (error) {
        log(`JS Call Hierarchy API not available: ${error}`);
    }

    // 2. Fallback: extract from displayName
    if (!methodSignature) {
        methodSignature = extractMethodSignatureJS(
            windowData.displayName, windowData.filePath, windowData.startLine
        );
        log(`Extracted JS method signature (fallback): ${methodSignature}`);
    }
    if (perfEnabled) { perfLog(opName, 'resolveSignature', Date.now() - t0); }

    if (!methodSignature) {
        vscode.window.showErrorMessage('関数シグネチャを解決できませんでした');
        return;
    }

    // 3. Analyze via JS Call Hierarchy API
    // Pass htmlPath from active JSON metadata so vanilla JS context is preserved
    const htmlPath = activeJsonPath ? getHtmlPathFromActiveJson(activeJsonPath) : undefined;
    let t1 = 0;
    if (perfEnabled) { t1 = Date.now(); }
    try {
        const result = await vscode.commands.executeCommand<{ success: boolean; data?: any; error?: string; timing?: Array<{ phase: string; elapsedMs: number; detail?: string }> }>(
            'jsCallHierarchy.analyzeMethod',
            { filePath: windowData.filePath, methodSignature, depth: 1, htmlPath }
        );
        if (perfEnabled) { perfLog(opName, 'jsAnalysis', Date.now() - t1, result?.data ? `windows:${result.data.windows?.length || 0},connections:${result.data.connections?.length || 0}` : undefined); }

        // Relay JS extension timing entries if present
        if (perfEnabled && result?.timing) {
            emitJsTimingEntries(result.timing);
        }

        if (result?.success && result.data) {
            panel.webview.postMessage({
                command: 'mergeCallCanvasData',
                data: result.data,
                sourceWindowDisplayName: windowData.displayName,
                sourceWindowId: windowData.id
            });
            vscode.window.showInformationMessage(
                `${result.data.windows?.length || 0} 件の関数を検出しました`
            );
        } else {
            vscode.window.showErrorMessage(`解析失敗: ${result?.error || '不明なエラー'}`);
        }
    } catch (error) {
        vscode.window.showErrorMessage(
            'JavaScript Call Hierarchy拡張がインストールされていないか、エラーが発生しました'
        );
    }
    if (perfEnabled) { perfTotal(opName, Date.now() - totalStart); }
}

/**
 * Re-analyze the root method for JavaScript/TypeScript files using jsCallHierarchy.analyzeMethod API.
 */
export async function reanalyzeRootJS(
    rootWindow: { displayName: string; filePath: string; code: any; startLine: number },
    absoluteFilePath: string,
    panel: vscode.WebviewPanel,
    _context: vscode.ExtensionContext,
    activeJsonPath: vscode.Uri
): Promise<void> {
    const perfEnabled = isPerfLogEnabled();
    const opName = 'reanalyzeRoot';
    let totalStart = 0;
    if (perfEnabled) { totalStart = Date.now(); }

    // Resolve method signature via JS Call Hierarchy API
    let t0 = 0;
    if (perfEnabled) { t0 = Date.now(); }
    let methodSignature: string | null = null;
    try {
        methodSignature = await vscode.commands.executeCommand<string | null>(
            'jsCallHierarchy.resolveMethodSignature',
            absoluteFilePath,
            rootWindow.startLine
        );
        if (methodSignature) {
            log(`Got method signature from JS Call Hierarchy API: ${methodSignature}`);
        }
    } catch (error) {
        log(`JS Call Hierarchy API not available: ${error}`);
    }

    // Fallback: extract from displayName
    if (!methodSignature) {
        methodSignature = extractMethodSignatureJS(rootWindow.displayName, rootWindow.filePath, rootWindow.startLine);
        log(`Extracted method signature (fallback): ${methodSignature}`);
    }
    if (perfEnabled) { perfLog(opName, 'resolveSignature', Date.now() - t0); }

    if (!methodSignature) {
        vscode.window.showErrorMessage('関数シグネチャを解決できませんでした');
        return;
    }

    // Pass htmlPath from active JSON metadata so vanilla JS context is preserved
    const htmlPath = getHtmlPathFromActiveJson(activeJsonPath);

    const depth = vscode.workspace.getConfiguration('jsCallHierarchy').get<number>('depth', 5);
    log(`Re-analyzing JS with signature: ${methodSignature}, depth: ${depth}`);

    let t1 = 0;
    if (perfEnabled) { t1 = Date.now(); }
    try {
        const result = await vscode.commands.executeCommand<{ success: boolean; data?: any; error?: string; timing?: Array<{ phase: string; elapsedMs: number; detail?: string }> }>(
            'jsCallHierarchy.analyzeMethod',
            { filePath: absoluteFilePath, methodSignature, depth, htmlPath }
        );
        if (perfEnabled) { perfLog(opName, 'apiCall', Date.now() - t1); }

        // Relay JS extension timing entries if present
        if (perfEnabled && result?.timing) {
            emitJsTimingEntries(result.timing);
        }

        if (result?.success && result.data) {
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
        if (perfEnabled) { perfLog(opName, 'apiCall', Date.now() - t1); }
        vscode.window.showErrorMessage(
            'JavaScript Call Hierarchy拡張がインストールされていないか、エラーが発生しました'
        );
    }
    if (perfEnabled) { perfTotal(opName, Date.now() - totalStart); }
}
