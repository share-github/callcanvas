import * as vscode from 'vscode';
import { log } from './logger';
import { extractMethodSignatureJS } from './methodExtractor';
import { isPerfLogEnabled, perfLog, perfTotal, emitJsTimingEntries } from './perfLogger';
import { ReanalysisPlan, ReanalysisResult } from './reanalysis';

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
    plan: ReanalysisPlan,
    absoluteFilePath: string
): Promise<ReanalysisResult> {
    const perfEnabled = isPerfLogEnabled();
    const opName = 'reanalyzeRoot';
    let totalStart = 0;
    if (perfEnabled) { totalStart = Date.now(); }

    // 1st attempt: replay the signature recorded when the canvas was exported.
    let methodSignature = plan.methodSignature;
    let resolvedFromSource = false;
    if (!methodSignature) {
        methodSignature = await resolveTsSignature(plan, absoluteFilePath, opName, perfEnabled);
        resolvedFromSource = true;
    }
    if (!methodSignature) {
        if (perfEnabled) { perfTotal(opName, Date.now() - totalStart); }
        return { success: false, error: '関数シグネチャを解決できませんでした' };
    }

    log(`Re-analyzing TS with signature: ${methodSignature}, depth: ${plan.depth}`);
    let result = await callTsAnalyzeApi(absoluteFilePath, methodSignature, plan.depth, opName, perfEnabled);

    // 2nd attempt: recorded signature is stale (renamed / moved function).
    if (!result.success && !resolvedFromSource && plan.rootWindow) {
        log(`Recorded signature failed (${result.error}) — re-resolving from source`);
        const freshSignature = await resolveTsSignature(plan, absoluteFilePath, opName, perfEnabled);
        if (freshSignature && freshSignature !== methodSignature) {
            result = await callTsAnalyzeApi(absoluteFilePath, freshSignature, plan.depth, opName, perfEnabled);
        }
    }

    if (perfEnabled) { perfTotal(opName, Date.now() - totalStart); }
    return result;
}

async function resolveTsSignature(
    plan: ReanalysisPlan,
    absoluteFilePath: string,
    opName: string,
    perfEnabled: boolean
): Promise<string | null> {
    let t0 = 0;
    if (perfEnabled) { t0 = Date.now(); }
    let methodSignature: string | null = null;
    try {
        methodSignature = await vscode.commands.executeCommand<string | null>(
            'tsCallHierarchy.resolveMethodSignature',
            absoluteFilePath,
            plan.declLine
        );
        if (methodSignature) {
            log(`Got method signature from TS Call Hierarchy API: ${methodSignature}`);
        }
    } catch (error) {
        log(`TS Call Hierarchy API not available: ${error}`);
    }

    if (!methodSignature && plan.rootWindow) {
        methodSignature = extractMethodSignatureJS(
            plan.rootWindow.displayName,
            plan.rootWindow.filePath,
            plan.declLine
        );
        log(`Extracted method signature (fallback): ${methodSignature}`);
    }
    if (perfEnabled) { perfLog(opName, 'resolveSignature', Date.now() - t0); }
    return methodSignature;
}

async function callTsAnalyzeApi(
    absoluteFilePath: string,
    methodSignature: string,
    depth: number,
    opName: string,
    perfEnabled: boolean
): Promise<ReanalysisResult> {
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

        if (!result?.success || !result.data) {
            return { success: false, error: result?.error || '不明なエラー' };
        }
        if ((result.data.windows?.length || 0) === 0) {
            return { success: false, error: `解析対象が見つかりませんでした (${methodSignature})` };
        }
        return { success: true, data: result.data, signature: methodSignature };
    } catch (error) {
        if (perfEnabled) { perfLog(opName, 'apiCall', Date.now() - t1); }
        return {
            success: false,
            error: 'TypeScript Call Hierarchy拡張がインストールされていないか、エラーが発生しました'
        };
    }
}
