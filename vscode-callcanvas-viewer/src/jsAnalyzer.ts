import * as vscode from 'vscode';
import * as fs from 'fs';
import { log } from './logger';
import { extractMethodSignatureJS } from './methodExtractor';
import { isPerfLogEnabled, perfLog, perfTotal, emitJsTimingEntries } from './perfLogger';
import { ReanalysisPlan, ReanalysisResult } from './reanalysis';

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
    plan: ReanalysisPlan,
    absoluteFilePath: string,
    activeJsonPath: vscode.Uri
): Promise<ReanalysisResult> {
    const perfEnabled = isPerfLogEnabled();
    const opName = 'reanalyzeRoot';
    let totalStart = 0;
    if (perfEnabled) { totalStart = Date.now(); }

    // Pass htmlPath from active JSON metadata so vanilla JS context is preserved
    const htmlPath = getHtmlPathFromActiveJson(activeJsonPath);

    // 1st attempt: replay the signature recorded when the canvas was exported.
    let methodSignature = plan.methodSignature;
    let resolvedFromSource = false;
    if (!methodSignature) {
        methodSignature = await resolveJsSignature(plan, absoluteFilePath, opName, perfEnabled);
        resolvedFromSource = true;
    }
    if (!methodSignature) {
        if (perfEnabled) { perfTotal(opName, Date.now() - totalStart); }
        return { success: false, error: '関数シグネチャを解決できませんでした' };
    }

    log(`Re-analyzing JS with signature: ${methodSignature}, depth: ${plan.depth}`);
    let result = await callJsAnalyzeApi(absoluteFilePath, methodSignature, plan.depth, htmlPath, opName, perfEnabled);

    // 2nd attempt: recorded signature is stale (renamed / moved function).
    if (!result.success && !resolvedFromSource && plan.rootWindow) {
        log(`Recorded signature failed (${result.error}) — re-resolving from source`);
        const freshSignature = await resolveJsSignature(plan, absoluteFilePath, opName, perfEnabled);
        if (freshSignature && freshSignature !== methodSignature) {
            result = await callJsAnalyzeApi(absoluteFilePath, freshSignature, plan.depth, htmlPath, opName, perfEnabled);
        }
    }

    if (perfEnabled) { perfTotal(opName, Date.now() - totalStart); }
    return result;
}

async function resolveJsSignature(
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
            'jsCallHierarchy.resolveMethodSignature',
            absoluteFilePath,
            plan.declLine
        );
        if (methodSignature) {
            log(`Got method signature from JS Call Hierarchy API: ${methodSignature}`);
        }
    } catch (error) {
        log(`JS Call Hierarchy API not available: ${error}`);
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

async function callJsAnalyzeApi(
    absoluteFilePath: string,
    methodSignature: string,
    depth: number,
    htmlPath: string | undefined,
    opName: string,
    perfEnabled: boolean
): Promise<ReanalysisResult> {
    let t1 = 0;
    if (perfEnabled) { t1 = Date.now(); }
    try {
        const result = await vscode.commands.executeCommand<{ success: boolean; data?: any; error?: string; timing?: Array<{ phase: string; elapsedMs: number; detail?: string }> }>(
            'jsCallHierarchy.analyzeMethod',
            { filePath: absoluteFilePath, methodSignature, depth, htmlPath }
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
            error: 'JavaScript Call Hierarchy拡張がインストールされていないか、エラーが発生しました'
        };
    }
}
