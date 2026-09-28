'use strict';
/**
 * Minimal stand-ins for the vscode value types (Uri / Position / Range / enums).
 * Only the members the CallCanvas extensions actually touch are implemented —
 * see README.md for the full surface list.
 */
const path = require('path');

class Uri {
    constructor(scheme, fsPath) {
        this.scheme = scheme;
        this._fsPath = fsPath;
    }
    static file(p) {
        return new Uri('file', path.resolve(String(p)));
    }
    static parse(value) {
        const s = String(value);
        const m = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^?#]*)/);
        if (!m) {
            return Uri.file(s);
        }
        // vscode-remote://<authority>/<path> — keep only the path part, which is
        // what the extensions use (fsPath).
        const rest = m[2];
        const slash = rest.indexOf('/');
        return new Uri(m[1], slash >= 0 ? rest.substring(slash) : '/');
    }
    static joinPath(base, ...parts) {
        return new Uri(base.scheme, path.join(base.fsPath, ...parts.map(String)));
    }
    get fsPath() {
        return this._fsPath;
    }
    get path() {
        return this._fsPath;
    }
    get authority() {
        return '';
    }
    get query() {
        return '';
    }
    get fragment() {
        return '';
    }
    with(change) {
        return new Uri(change && change.scheme ? change.scheme : this.scheme,
            change && change.path ? change.path : this._fsPath);
    }
    toString() {
        return `${this.scheme}://${this._fsPath}`;
    }
    toJSON() {
        return { scheme: this.scheme, path: this._fsPath, fsPath: this._fsPath };
    }
}

class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
    translate(dl = 0, dc = 0) {
        return new Position(this.line + dl, this.character + dc);
    }
    with(line = this.line, character = this.character) {
        return new Position(line, character);
    }
    isBefore(other) {
        return this.line < other.line || (this.line === other.line && this.character < other.character);
    }
    isEqual(other) {
        return this.line === other.line && this.character === other.character;
    }
}

class Range {
    constructor(startOrLine, endOrChar, endLine, endChar) {
        if (startOrLine instanceof Position) {
            this.start = startOrLine;
            this.end = endOrChar;
        } else {
            this.start = new Position(startOrLine, endOrChar);
            this.end = new Position(endLine, endChar);
        }
    }
    get isEmpty() {
        return this.start.isEqual(this.end);
    }
    get isSingleLine() {
        return this.start.line === this.end.line;
    }
}

class Selection extends Range {
    constructor(anchor, active) {
        super(anchor, active);
        this.anchor = anchor;
        this.active = active;
    }
}

const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };
const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
const StatusBarAlignment = { Left: 1, Right: 2 };
const ExtensionMode = { Production: 1, Development: 2, Test: 3 };
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const EndOfLine = { LF: 1, CRLF: 2 };

const LANGUAGE_IDS = {
    '.java': 'java',
    '.js': 'javascript',
    '.cjs': 'javascript',
    '.mjs': 'javascript',
    '.jsx': 'javascriptreact',
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.html': 'html',
    '.htm': 'html',
    '.jsp': 'jsp',
    '.json': 'json',
    '.md': 'markdown',
    '.xml': 'xml'
};

function languageIdFor(filePath) {
    return LANGUAGE_IDS[path.extname(String(filePath)).toLowerCase()] || 'plaintext';
}

module.exports = {
    Uri, Position, Range, Selection,
    ViewColumn, ProgressLocation, StatusBarAlignment, ExtensionMode,
    ConfigurationTarget, EndOfLine,
    languageIdFor
};
