import * as vscode from 'vscode';

let perfChannel: vscode.OutputChannel | undefined;

export function isPerfLogEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('callcanvas');
    return config.get<boolean>('performanceLog', false);
}

export function getPerfChannel(): vscode.OutputChannel {
    if (!perfChannel) {
        perfChannel = vscode.window.createOutputChannel('CallCanvas Performance');
    }
    return perfChannel;
}

/**
 * Log a single phase measurement.
 * Format: [PERF] <ISO8601> | <operation> | phase=<phase> | elapsed=<ms>ms [| detail=<detail>]
 */
export function perfLog(operation: string, phase: string, elapsedMs: number, detail?: string): void {
    if (!isPerfLogEnabled()) { return; }
    const ch = getPerfChannel();
    const ts = new Date().toISOString();
    let line = `[PERF] ${ts} | ${operation} | phase=${phase} | elapsed=${Math.round(elapsedMs)}ms`;
    if (detail) {
        line += ` | detail=${detail}`;
    }
    ch.appendLine(line);
}

/**
 * Log operation total time.
 * Format: [PERF] <ISO8601> | <operation> | TOTAL=<ms>ms
 */
export function perfTotal(operation: string, elapsedMs: number): void {
    if (!isPerfLogEnabled()) { return; }
    const ch = getPerfChannel();
    const ts = new Date().toISOString();
    ch.appendLine(`[PERF] ${ts} | ${operation} | TOTAL=${Math.round(elapsedMs)}ms`);
}

/**
 * Log a section header.
 */
export function perfSection(title: string): void {
    if (!isPerfLogEnabled()) { return; }
    const ch = getPerfChannel();
    ch.appendLine(`=== ${title} ===`);
}

/**
 * Parse Java CLI [TIMING] lines from stderr and relay them to the perf channel.
 * Only emits generic block names — no file paths, class names, or method names.
 */
export function emitJavaTimingLines(operation: string, stderr: string): void {
    if (!isPerfLogEnabled()) { return; }
    const ch = getPerfChannel();
    for (const line of stderr.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[TIMING]')) {
            // Relay as [PERF-JAVA] with the content after [TIMING]
            const content = trimmed.substring('[TIMING]'.length).trim();
            ch.appendLine(`[PERF-JAVA] ${content}`);
        }
    }
}

/**
 * Relay timing entries returned by JS Call Hierarchy extension.
 */
export function emitJsTimingEntries(entries: Array<{ phase: string; elapsedMs: number; detail?: string }>): void {
    if (!isPerfLogEnabled()) { return; }
    const ch = getPerfChannel();
    for (const entry of entries) {
        let line = `[PERF-JS] ${entry.phase}: ${Math.round(entry.elapsedMs)}ms`;
        if (entry.detail) {
            line += ` | detail=${entry.detail}`;
        }
        ch.appendLine(line);
    }
}
