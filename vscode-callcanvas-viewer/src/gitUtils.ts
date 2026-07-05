import * as vscode from 'vscode';
import { exec } from 'child_process';

/** Detailed diff types for before/after display */
export type DiffLineEntry = { type: 'add' | 'remove'; content: string };
export type DiffHunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: DiffLineEntry[] };
export type FileDiff = { filePath: string; hunks: DiffHunk[] };

/**
 * Parse git diff output into detailed FileDiff structures including
 * added/removed line content for before/after inline display.
 */
export function parseGitDiffDetailed(stdout: string): FileDiff[] {
    const result: FileDiff[] = [];
    const rawLines = stdout.split('\n');
    let currentFile = '';
    let currentHunks: DiffHunk[] = [];
    let currentHunk: DiffHunk | null = null;

    const pushCurrentFile = () => {
        if (currentHunk) currentHunks.push(currentHunk);
        if (currentFile) result.push({ filePath: currentFile, hunks: currentHunks });
    };

    for (const line of rawLines) {
        if (line.startsWith('+++ b/')) {
            if (currentHunk) { currentHunks.push(currentHunk); currentHunk = null; }
            if (currentFile) result.push({ filePath: currentFile, hunks: currentHunks });
            currentFile = line.substring(6);
            currentHunks = [];
        } else if (line.startsWith('@@')) {
            if (currentHunk) currentHunks.push(currentHunk);
            const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (match) {
                let oldCount = 1;
                if (match[2] !== undefined) oldCount = parseInt(match[2]);
                let newCount = 1;
                if (match[4] !== undefined) newCount = parseInt(match[4]);
                currentHunk = {
                    oldStart: parseInt(match[1]),
                    oldCount: oldCount,
                    newStart: parseInt(match[3]),
                    newCount: newCount,
                    lines: []
                };
            }
        } else if (currentHunk) {
            if (line.startsWith('-') && !line.startsWith('---')) {
                currentHunk.lines.push({ type: 'remove', content: line.substring(1) });
            } else if (line.startsWith('+') && !line.startsWith('+++')) {
                currentHunk.lines.push({ type: 'add', content: line.substring(1) });
            }
        }
    }
    if (currentHunk) currentHunks.push(currentHunk);
    if (currentFile) result.push({ filePath: currentFile, hunks: currentHunks });
    return result;
}


/**
 * Get commit changes from git and send to webview
 */
export async function getCommitChanges(commitHash: string, panel: vscode.WebviewPanel): Promise<void> {
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const gitCommand = `git show -m ${commitHash} --unified=0 --no-color`;

        exec(gitCommand, { cwd: workspaceRoot, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                vscode.window.showErrorMessage(`Git error: ${stderr || error.message}`);
                return;
            }

            const diffs = parseGitDiffDetailed(stdout);
            panel.webview.postMessage({
                command: 'commitDiffDetails',
                diffs: diffs
            });
            vscode.window.showInformationMessage(`Found changes in ${diffs.length} file(s)`);
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to get commit changes: ${error}`);
    }
}

/**
 * Get workbench (uncommitted) changes and send to webview.
 * Uses git diff HEAD: working tree + staged vs HEAD.
 */
export async function getWorkbenchChanges(panel: vscode.WebviewPanel): Promise<void> {
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const gitCommand = 'git diff HEAD --unified=0 --no-color';

        exec(gitCommand, { cwd: workspaceRoot, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                vscode.window.showErrorMessage(`Git error: ${stderr || error.message}`);
                return;
            }

            const diffs = parseGitDiffDetailed(stdout);
            panel.webview.postMessage({
                command: 'commitDiffDetails',
                diffs: diffs
            });
            vscode.window.showInformationMessage(`ワークベンチの変更: ${diffs.length} ファイル`);
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to get workbench changes: ${error}`);
    }
}
