import * as vscode from 'vscode';
import * as fs from 'fs';
import { log } from './logger';
import { extractMethodSignatureJS } from './methodExtractor';
import { isPerfLogEnabled, perfLog, perfTotal, emitJsTimingEntries } from './perfLogger';

/**
 * Analyze next level for TypeScript/TSX via TypeScript Call Hierarchy extension API.
 */
export async function analyzeNextLevelTS(
    windowData: { id?: string; displayName: string; filePath: string; code: string; startLine: number },
    panel: vscode.WebviewPanel,
    _context: vscode.ExtensionContext,
    _activeJsonPath?: vscode.Uri
): Promise<void> {
    const perfEnabled = isPerfLogEnabled();
    const opName = 'analyzeNextLevel';
    let totalStart = 0;
    if (perfEnabled) { totalStart = Date.now(); }

    let t0 = 0;
    if (perfEnabled) { t0 = Date.now(); }
    let methodSignature: string | null = null;
    try {
        methodSignature = await vscode.commands.executeCommand<string | null>(
            'tsCallHierarchy.resolveMethodSignature',
            windowData.filePath,
            windowData.startLine
        );
        if (methodSignature) {
            log(`Got method signature from TS Call Hierarchy API: ${methodSignature}`);
        }
    } catch (error) {
        log(`TS Call Hierarchy API not available: ${error}`);
    }

    if (!methodSignature) {
        methodSignature = extractMethodSignatureJS(
            windowData.displayName, windowData.filePath, windowData.startLine
        );
        log(`Extracted TS method signature (fallback): ${methodSignature}`);
    }
    if (perfEnabled) { perfLog(opName, 'resolveSignature', Date.now() - t0); }

    if (!methodSignature) {
        vscode.window.showErrorMessage('関数シグネチャを解決できませんでした');
        return;
    }

    let t1 = 0;
    if (perfEnabled) { t1 = Date.now(); }
    try {
        const result = await vscode.commands.executeCommand<{ success: boolean; data?: any; error?: string; timing?: Array<{ phase: string; elapsedMs: number; detail?: string }> }>(
            'tsCallHierarchy.analyzeMethod',
            { filePath: windowData.filePath, methodSignature, depth: 1 }
        );
        if (perfEnabled) { perfLog(opName, 'tsAnalysis', Date.now() - t1, result?.data ? `windows:${result.data.windows?.length || 0},connections:${result.data.connections?.length || 0}` : undefined); }

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
            'TypeScript Call Hierarchy拡張がインストールされていないか、エラーが発生しました'
        );
    }
    if (perfEnabled) { perfTotal(opName, Date.now() - totalStart); }
}

/**
 * Re-analyze the root method for TypeScript/TSX using tsCallHierarchy.analyzeMethod API.
 */
export async function reanalyzeRootTS(
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

    let t0 = 0;
    if (perfEnabled) { t0 = Date.now(); }
    let methodSignature: string | null = null;
    try {
        methodSignature = await vscode.commands.executeCommand<string | null>(
            'tsCallHierarchy.resolveMethodSignature',
            absoluteFilePath,
            rootWindow.startLine
        );
        if (methodSignature) {
            log(`Got method signature from TS Call Hierarchy API: ${methodSignature}`);
        }
    } catch (error) {
        log(`TS Call Hierarchy API not available: ${error}`);
    }

    if (!methodSignature) {
        methodSignature = extractMethodSignatureJS(rootWindow.displayName, rootWindow.filePath, rootWindow.startLine);
        log(`Extracted method signature (fallback): ${methodSignature}`);
    }
    if (perfEnabled) { perfLog(opName, 'resolveSignature', Date.now() - t0); }

    if (!methodSignature) {
        vscode.window.showErrorMessage('関数シグネチャを解決できませんでした');
        return;
    }

    const depth = vscode.workspace.getConfiguration('tsCallHierarchy').get<number>('depth', 5);
    log(`Re-analyzing TS with signature: ${methodSignature}, depth: ${depth}`);

    let t1 = 0;
    if (perfEnabled) { t1 = Date.now(); }
    try {
        const result = await vscode.commands.executeCommand<{ success: boolean; data?: any; error?: string; timing?: Array<{ phase: string; elapsedMs: number; detail?: string }> }>(
            'tsCallHierarchy.analyzeMethod',
            { filePath: absoluteFilePath, methodSignature, depth }
        );
        if (perfEnabled) { perfLog(opName, 'apiCall', Date.now() - t1); }

        if (perfEnabled && result?.timing) {
            emitJsTimingEntries(result.timing);
        }

        if (result?.success && result.data) {
            const newData = result.data;

            try {
                fs.writeFileSync(activeJsonPath.fsPath, JSON.stringify(newData, null, 2), 'utf8');
                log(`Saved re-analyzed data to: ${activeJsonPath.fsPath}`);
            } catch (saveError) {
                log(`Failed to save JSON: ${saveError}`);
            }

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
            'TypeScript Call Hierarchy拡張がインストールされていないか、エラーが発生しました'
        );
    }
    if (perfEnabled) { perfTotal(opName, Date.now() - totalStart); }
}
