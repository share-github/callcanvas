import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('CallCanvas Analyzer');
    }
    return outputChannel;
}

export function isDebugEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('callcanvas');
    return config.get<boolean>('debug', false);
}

export function log(message: string): void {
    if (!isDebugEnabled()) {
        return;
    }
    const channel = getOutputChannel();
    const timestamp = new Date().toISOString();
    channel.appendLine(`[${timestamp}] ${message}`);
}

export function logError(message: string): void {
    // Always log errors
    const channel = getOutputChannel();
    const timestamp = new Date().toISOString();
    channel.appendLine(`[${timestamp}] ERROR: ${message}`);
}

export function showDebugOutput(): void {
    if (isDebugEnabled()) {
        getOutputChannel().show(true);
    }
}
