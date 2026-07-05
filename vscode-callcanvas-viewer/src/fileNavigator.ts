import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export async function openFileAtLine(filePath: string, line: number) {
    try {
        // Get workspace folders
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        let fileUri: vscode.Uri | undefined;

        // If filePath is already absolute, derive URI from workspace root to preserve
        // the correct URI scheme (vscode-remote:// in dev containers).
        // Using vscode.Uri.file() would produce a file:// URI which fails in dev containers.
        if (path.isAbsolute(filePath)) {
            const workspaceRoot = workspaceFolders[0].uri;
            const relativePath = path.relative(workspaceRoot.fsPath, filePath);
            if (!relativePath.startsWith('..')) {
                fileUri = vscode.Uri.joinPath(workspaceRoot, relativePath);
            } else {
                // Outside workspace root — fall back to file:// URI
                fileUri = vscode.Uri.file(filePath);
            }
        } else {
            // Search for the file in the workspace using glob pattern
            // This supports multi-module projects where files may be in submodules
            const files = await vscode.workspace.findFiles(`**/${filePath}`, null, 10);

            if (files.length === 0) {
                vscode.window.showErrorMessage(`File not found in workspace: ${filePath}`);
                return;
            }

            // If multiple files found, filter by exact path match
            const matchingFiles = files.filter(uri =>
                uri.fsPath.endsWith(filePath.replace(/\//g, path.sep))
            );

            fileUri = matchingFiles.length > 0 ? matchingFiles[0] : files[0];
        }

        // Check if file exists
        if (!fs.existsSync(fileUri.fsPath)) {
            vscode.window.showErrorMessage(`File not found: ${filePath}`);
            return;
        }

        // Use vscode.open with ViewColumn.Beside for split editor on double-click.
        // Beside works in both VS Code and Cursor (ViewColumn.Two does not split in Cursor).
        const position = new vscode.Position(Math.max(0, line - 1), 0);
        await vscode.commands.executeCommand('vscode.open', fileUri, {
            viewColumn: vscode.ViewColumn.Beside,
            selection: new vscode.Range(position, position),
            preserveFocus: false
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to open file: ${error}`);
    }
}
