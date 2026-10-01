import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { log, logError } from './logger';
import { ChangeSetTarget, getRepoRoot, parseChangeSetTarget, showCommitHashInput } from './gitUtils';
import {
    ClientsideAnalysis, ClientsideChangeSetResult, ClientsideRequestFile, JavaChangeSetRequestFile, JavaChangeSetResult,
    clientsideSeedKey, generateChangeSetCanvas
} from './changeSet';

/** 表示用の対象名（コミットは入力どおりの hash、ワークベンチは「ワークベンチ」） */
function targetLabel(target: ChangeSetTarget): string {
    return target.kind === 'workbench' ? 'ワークベンチ' : target.commit;
}

/**
 * 対象を訊く。既存の差分表示（「📝 コミット変更」「📄 ワークベンチ」）と同じ 2 択で、
 * コミットはその入力欄（showCommitHashInput）で hash を受ける
 */
async function askChangeSetTarget(): Promise<ChangeSetTarget | undefined> {
    const items: (vscode.QuickPickItem & { kind2: 'commit' | 'workbench' })[] = [
        { label: '📝 コミット', description: 'コミットハッシュを入力（そのコミットの変更）', kind2: 'commit' },
        { label: '📄 ワークベンチ', description: '未コミットの変更（git diff HEAD）', kind2: 'workbench' },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: '変更集合キャンバス: どの変更を見ますか' });
    if (!picked) return undefined;
    if (picked.kind2 === 'workbench') return { kind: 'workbench' };
    const hash = await showCommitHashInput();
    return hash ? { kind: 'commit', commit: hash } : undefined;
}

async function analyzeJavaChangeSet(
    repoRoot: string,
    anchorFile: string | undefined,
    files: JavaChangeSetRequestFile[]
): Promise<JavaChangeSetResult> {
    try {
        const result = await vscode.commands.executeCommand<JavaChangeSetResult>('javaCallHierarchy.analyzeChangeSet', {
            workspaceRoot: repoRoot,
            anchorFile,
            files,
        });
        return result || { success: false, error: 'Java Call Hierarchy 拡張から結果がありません' };
    } catch (error) {
        logError(`javaCallHierarchy.analyzeChangeSet failed: ${error}`);
        return { success: false, error: `Java Call Hierarchy 拡張がインストールされていないか、エラーが発生しました（${error}）` };
    }
}

/**
 * clientside の解析。JS/TS 拡張の既存 API をそのまま呼ぶ（.js 等は jsCallHierarchy、.ts/.tsx は tsCallHierarchy。
 * Analyze Next Level と同じ使い分け）。関数の解決は resolveMethodSignatures、呼び出し関係は analyzeMethod
 * （depth は渡さず各拡張の設定に従う）、テンプレートの include 辺は jsCallHierarchy.collectIncludeEdges。
 * 拡張が無い・失敗したファイルは errors に理由を入れる（合成側でファイル単位に戻す）。
 */
async function analyzeClientsideChangeSet(repoRoot: string, files: ClientsideRequestFile[]): Promise<ClientsideChangeSetResult> {
    const result: ClientsideChangeSetResult = { lineSignatures: {}, analyses: {}, includeEdges: [], templateContents: {}, templatesAnalyzed: [], errors: {} };
    const errors = result.errors!;
    const rel = (abs: string) => path.relative(repoRoot, abs).split(path.sep).join('/');
    for (const f of files) {
        const abs = path.join(repoRoot, f.path);
        if (f.kind === 'template') {
            try {
                const r = await vscode.commands.executeCommand<{ success: boolean; nodes?: string[]; edges?: Array<{ fromFile: string; toFile: string; directiveLine: number }>; error?: string }>(
                    'jsCallHierarchy.collectIncludeEdges', abs);
                if (r && r.success) {
                    result.templatesAnalyzed!.push(f.path);
                    for (const e of r.edges || []) result.includeEdges.push({ from: rel(e.fromFile), to: rel(e.toFile), line: e.directiveLine });
                    // 未変更テンプレートを中継（via）に描くための全文（Export HTML Include Map と同じく作業ツリーの内容）
                    for (const n of r.nodes || []) {
                        const key = rel(n);
                        if (key in result.templateContents!) continue;
                        try { result.templateContents![key] = fs.readFileSync(n, 'utf-8'); } catch { /* 読めない節点は空 */ }
                    }
                } else {
                    // テンプレート以外の拡張子（include 解析の対象外のファイル）は include を持たないので理由を残さない
                    log(`collectIncludeEdges skipped ${f.path}: ${r ? r.error : 'no result'}`);
                }
            } catch (error) {
                log(`jsCallHierarchy.collectIncludeEdges not available: ${error}`);
            }
            continue;
        }
        const api = f.kind === 'typescript' ? 'tsCallHierarchy' : 'jsCallHierarchy';
        const extName = f.kind === 'typescript' ? 'TypeScript Call Hierarchy' : 'JavaScript Call Hierarchy';
        let sigs: (string | null)[] | null = null;
        try {
            sigs = f.lines.length === 0 ? [] : (await vscode.commands.executeCommand<(string | null)[] | null>(`${api}.resolveMethodSignatures`, abs, f.lines)) ?? null;
        } catch (error) {
            logError(`${api}.resolveMethodSignatures failed: ${error}`);
            errors[f.path] = `${extName} 拡張がインストールされていないか、エラーが発生しました`;
            continue;
        }
        if (!Array.isArray(sigs)) {
            errors[f.path] = '関数を解決できませんでした';
            continue;
        }
        const byLine: Record<string, string | null> = {};
        f.lines.forEach((l, i) => { byLine[String(l)] = sigs![i] ?? null; });
        result.lineSignatures[f.path] = byLine;
        for (const sig of new Set(Object.values(byLine).filter((x): x is string => !!x))) {
            let a: ClientsideAnalysis;
            try {
                a = (await vscode.commands.executeCommand<ClientsideAnalysis>(`${api}.analyzeMethod`, { filePath: abs, methodSignature: sig }))
                    || { success: false, error: `${extName} 拡張から結果がありません` };
            } catch (error) {
                a = { success: false, error: `${extName} 拡張がインストールされていないか、エラーが発生しました（${error}）` };
            }
            result.analyses[clientsideSeedKey(f.path, sig)] = a;
        }
    }
    return result;
}

/**
 * callcanvas.openChangeSet: コミットかワークベンチの変更を 1 枚のキャンバスにして Viewer で開く。
 * 保存先は <リポジトリ>/build/call-hierarchy-output/callcanvas_changeset_<hash 先頭 8 文字 | workbench>.json。
 * targetArg（executeCommand の引数。hash か `workbench`）があれば訊かずにそれを使う（nvim ホストの `callcanvas changeset <hash>`）。
 */
export async function openChangeSet(openViewer: (jsonPath: vscode.Uri) => Promise<void>, targetArg?: string): Promise<void> {
    const editorFile = vscode.window.activeTextEditor?.document?.uri?.fsPath;
    const startDir = (editorFile && fs.existsSync(editorFile))
        ? path.dirname(editorFile)
        : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!startDir) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }
    const repoRoot = await getRepoRoot(startDir);
    if (!repoRoot) {
        vscode.window.showErrorMessage(`git リポジトリが見つかりません: ${startDir}`);
        return;
    }

    let target: ChangeSetTarget | undefined;
    try {
        target = (typeof targetArg === 'string' && targetArg.trim())
            ? parseChangeSetTarget(targetArg)
            : await askChangeSetTarget();
    } catch (e) {
        vscode.window.showErrorMessage(`変更集合の対象が不正です: ${e instanceof Error ? e.message : e}`);
        return;
    }
    if (!target) return;
    const text = targetLabel(target);

    const anchorFile = (editorFile && editorFile.endsWith('.java') && editorFile.startsWith(repoRoot + path.sep)) ? editorFile : undefined;

    let generated;
    try {
        generated = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `変更集合を作成中: ${text}`,
            cancellable: false
        }, () => generateChangeSetCanvas({
            repoRoot,
            target,
            analyzeJava: (files) => analyzeJavaChangeSet(repoRoot, anchorFile, files),
            analyzeClientside: (files) => analyzeClientsideChangeSet(repoRoot, files),
        }));
    } catch (e) {
        logError(`openChangeSet failed: ${e}`);
        vscode.window.showErrorMessage(`変更集合の作成に失敗しました: ${e instanceof Error ? e.message : e}`);
        return;
    }

    if (generated.fileCount === 0) {
        // 既存の差分表示と同じ言い方（ワークベンチは getWorkbenchChanges の「ワークベンチの変更: N ファイル」）
        vscode.window.showInformationMessage(target.kind === 'workbench'
            ? 'ワークベンチの変更: 0 ファイル'
            : `コミット ${text} の変更: 0 ファイル`);
        return;
    }
    if (generated.javaError) {
        vscode.window.showErrorMessage(generated.javaError);
    }
    if (generated.clientsideError) {
        vscode.window.showErrorMessage(generated.clientsideError);
    }
    if (generated.errors.length > 0) {
        // 契約の不変条件の違反（生成側の不具合）。開けるものは開く
        logError(`Change set invariant violations:\n  ${generated.errors.join('\n  ')}`);
        vscode.window.showErrorMessage(`変更集合キャンバスに不整合があります（${generated.errors.length} 件。出力チャンネル参照）`);
    }

    const outDir = path.join(repoRoot, 'build', 'call-hierarchy-output');
    const jsonPath = path.join(outDir, `callcanvas_changeset_${generated.shortName}.json`);
    try {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(jsonPath, JSON.stringify(generated.canvas, null, 2), 'utf8');
    } catch (e) {
        vscode.window.showErrorMessage(`変更集合キャンバスの保存に失敗しました: ${e}`);
        return;
    }
    log(`Change set canvas saved: ${jsonPath} (${generated.fileCount} files, ${generated.canvas.windows.length} windows)`);
    await openViewer(vscode.Uri.file(jsonPath));
}
