import * as vscode from 'vscode';
import { exec, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Detailed diff types for before/after display */
export type DiffLineEntry = { type: 'add' | 'remove'; content: string };
export type DiffHunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: DiffLineEntry[] };
/**
 * filePath は新しい側のパス（削除ファイルは旧パス）。
 * oldPath はリネーム時の旧パス、binary はバイナリ（hunk 無し）のときだけ付く。
 */
export type FileDiff = { filePath: string; hunks: DiffHunk[]; oldPath?: string; binary?: boolean };

/**
 * Parse git diff output into detailed FileDiff structures including
 * added/removed line content for before/after inline display.
 *
 * ファイルの区切りは `diff --git` 行（無ければ hunk の外の `--- ` 行）。
 * パスは `+++ b/`（削除ファイルは `--- a/`）、リネームは `rename from/to`、
 * hunk も ---/+++ も無いもの（バイナリ・モードだけの変更）は `diff --git` 行から取る。
 * hunk の中身は @@ の行数で数えるので、内容が `--- ` / `+++ ` で始まる行も hunk に入る。
 *
 * テストは本関数をソースから切り出し、型注釈を簡易に外して動かす（load-functions.js）。
 * そのため補助関数は中に置き、型付きアロー関数や `) ? a : b` の三項演算子は使わない。
 */
export function parseGitDiffDetailed(stdout: string): FileDiff[] {
    const result: FileDiff[] = [];
    const rawLines = stdout.split('\n');
    let current: FileDiff | null = null;
    let headerPath = '';     // diff --git 行から取ったパス（フォールバック）
    let minusPath = '';      // --- a/ のパス
    let plusPath = '';       // +++ b/ のパス
    let renameFrom = '';
    let renameTo = '';
    let currentHunk: DiffHunk | null = null;
    let oldRemaining = 0;
    let newRemaining = 0;

    // git の C 形式クォート（"a/\303\251.txt" 等）を外す
    function unquote(p: string): string {
        if (!p.startsWith('"') || !p.endsWith('"') || p.length < 2) return p;
        const body = p.slice(1, -1);
        const bytes: number[] = [];
        const esc: { [k: string]: number } = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '\\': 92, '"': 34 };
        for (let i = 0; i < body.length; i++) {
            const ch = body[i];
            if (ch === '\\' && i + 1 < body.length) {
                const nx = body[i + 1];
                if (/[0-7]/.test(nx)) {
                    bytes.push(parseInt(body.substr(i + 1, 3), 8));
                    i += 3;
                } else {
                    bytes.push(esc[nx] !== undefined ? esc[nx] : nx.charCodeAt(0));
                    i += 1;
                }
            } else {
                for (const b of Buffer.from(ch, 'utf-8')) bytes.push(b);
            }
        }
        return Buffer.from(bytes).toString('utf-8');
    }
    // "a/x" → "x"、/dev/null → ''。--- / +++ 行は末尾にタブが付くことがある
    function stripSide(p: string, prefix: string): string {
        const v = unquote(p.replace(/\t$/, ''));
        if (v === '/dev/null') return '';
        if (v.startsWith(prefix)) return v.substring(prefix.length);
        return v;
    }
    // "diff --git a/P b/Q" のパス。リネームでなければ P === Q なので長さから割る（空白入りパス対策）
    function pathFromGitHeader(rest: string): string {
        if (rest.startsWith('"')) {
            const m = rest.match(/^"((?:[^"\\]|\\.)*)" (.*)$/);
            if (!m) return '';
            return stripSide(m[2], 'b/');
        }
        if (rest.endsWith('"')) {
            const idx = rest.lastIndexOf(' "');
            if (idx < 0) return '';
            return stripSide(rest.substring(idx + 1), 'b/');
        }
        if ((rest.length - 1) % 2 === 0) {
            const half = (rest.length - 1) / 2;
            const a = rest.substring(0, half);
            const b = rest.substring(half + 1);
            if (a.startsWith('a/') && b.startsWith('b/') && a.substring(2) === b.substring(2)) return b.substring(2);
        }
        const idx = rest.lastIndexOf(' b/');
        if (idx < 0) return '';
        return rest.substring(idx + 3);
    }

    function flushHunk() {
        if (currentHunk && current) current.hunks.push(currentHunk);
        currentHunk = null;
        oldRemaining = 0;
        newRemaining = 0;
    }
    function flushFile() {
        flushHunk();
        if (current) {
            const isRename = renameFrom !== '' && renameTo !== '' && renameFrom !== renameTo;
            current.filePath = plusPath || renameTo || minusPath || headerPath;
            if (isRename) current.oldPath = renameFrom;
            if (current.filePath) result.push(current);
        }
        current = null;
        headerPath = minusPath = plusPath = renameFrom = renameTo = '';
    }
    function startFile() {
        flushFile();
        current = { filePath: '', hunks: [] };
    }

    for (const line of rawLines) {
        // hunk の中（@@ の行数が残っている間）は内容行
        if (currentHunk && (oldRemaining > 0 || newRemaining > 0)) {
            const h: DiffHunk = currentHunk;
            if (line.startsWith('-') && oldRemaining > 0) {
                h.lines.push({ type: 'remove', content: line.substring(1) });
                oldRemaining--;
                continue;
            } else if (line.startsWith('+') && newRemaining > 0) {
                h.lines.push({ type: 'add', content: line.substring(1) });
                newRemaining--;
                continue;
            } else if (line.startsWith(' ')) {
                oldRemaining = Math.max(0, oldRemaining - 1);
                newRemaining = Math.max(0, newRemaining - 1);
                continue;
            } else if (line.startsWith('\\')) {
                continue; // "\ No newline at end of file"
            }
            // 行数と合わない入力は、以下の通常処理に任せる
        }

        if (line.startsWith('diff --git ')) {
            startFile();
            headerPath = pathFromGitHeader(line.substring('diff --git '.length));
        } else if (line.startsWith('--- ')) {
            // diff --git 行の無い入力では --- がファイルの区切り
            const inHeader = current !== null && !currentHunk && (current as FileDiff).hunks.length === 0 && !minusPath && !plusPath;
            if (!inHeader) startFile();
            minusPath = stripSide(line.substring(4), 'a/');
        } else if (line.startsWith('+++ ') && current && !currentHunk) {
            plusPath = stripSide(line.substring(4), 'b/');
        } else if (line.startsWith('rename from ') && current && !currentHunk) {
            renameFrom = unquote(line.substring('rename from '.length));
        } else if (line.startsWith('rename to ') && current && !currentHunk) {
            renameTo = unquote(line.substring('rename to '.length));
        } else if ((line.startsWith('Binary files ') || line === 'GIT binary patch') && current && !currentHunk) {
            (current as FileDiff).binary = true;
        } else if (line.startsWith('@@')) {
            flushHunk();
            const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (match) {
                if (!current) current = { filePath: '', hunks: [] };
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
                oldRemaining = oldCount;
                newRemaining = newCount;
            }
        } else if (currentHunk) {
            // @@ の行数を超えた +/- 行も従来どおり拾う（手書きの差分など）
            const h: DiffHunk = currentHunk;
            if (line.startsWith('-') && !line.startsWith('---')) {
                h.lines.push({ type: 'remove', content: line.substring(1) });
            } else if (line.startsWith('+') && !line.startsWith('+++')) {
                h.lines.push({ type: 'add', content: line.substring(1) });
            } else if (!line.startsWith(' ') && !line.startsWith('\\')) {
                flushHunk(); // コミットヘッダ等。hunk の外に出た
            }
        }
    }
    flushFile();
    return result;
}

// ---------------------------------------------------------------------------
// 変更集合キャンバス（Change Set Canvas）用の git 層
//
// vscode.git 拡張 API は nvim ホストのシムで動かないので child_process で git を呼ぶ。
// パスはすべてリポジトリのトップレベルからの相対パス（'/' 区切り）。cwd にはトップレベルを渡す
// （getRepoRoot で求める）。
// ---------------------------------------------------------------------------

/**
 * コミットハッシュの入力欄（「📝 コミット変更」の差分表示と変更集合キャンバスで共用）。
 * 取り消し・空なら undefined
 */
export async function showCommitHashInput(): Promise<string | undefined> {
    const commitHash = await vscode.window.showInputBox({
        prompt: 'コミットハッシュを入力してください',
        placeHolder: '例: 7d0b453 または 7d0b453fa33636440206a9632692b212fb631ee0',
        validateInput: (value) => {
            if (!value || value.trim().length === 0) {
                return 'コミットハッシュを入力してください';
            }
            if (value.trim().length < 7) {
                return 'コミットハッシュは最低7文字必要です';
            }
            return null;
        }
    });
    return commitHash ? commitHash.trim() : undefined;
}

/**
 * 変更集合の対象。既存の差分表示（「📝 コミット変更」「📄 ワークベンチ」）と同じ 2 種:
 * commit = そのコミットの変更（第 1 親との差 C^1..C。ルートコミットは空ツリーとの差）、
 * workbench = 未コミットの変更（git diff HEAD = 作業ツリー＋ステージと HEAD の差。追跡ファイルのみ）
 */
export type ChangeSetTarget =
    | { kind: 'commit'; commit: string }
    | { kind: 'workbench' };

/** ワークベンチを指す引数（nvim の `:CallCanvasChangeSet workbench`・`callcanvas changeset workbench`） */
export const WORKBENCH_ARG = 'workbench';

/** 解決済みの比較。base / head は完全な hash。head が null なら作業ツリー（ワークベンチ。base は HEAD） */
export type ResolvedChangeSet = { base: string; head: string | null };

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** 変更ファイル 1 つ。hunks は --unified=0（add/remove 行のみ）。削除ファイルの filePath は旧パス */
export type ChangedFile = {
    filePath: string;
    status: ChangeStatus;
    oldPath?: string;
    binary: boolean;
    hunks: DiffHunk[];
};

export type BlockKind = 'java' | 'clientside' | 'xml' | 'sql' | 'other';

/** ブロックの表示順（契約: java, clientside, xml, sql, other） */
export const BLOCK_ORDER: BlockKind[] = ['java', 'clientside', 'xml', 'sql', 'other'];

/** git のツリーが空のときの hash（親の無いルートコミットの比較元） */
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** 出力・パスの表記を利用者の git 設定に左右されないようにする共通オプション */
const GIT_BASE_ARGS = ['-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false'];

type GitRunResult = { code: number; stdout: Buffer; stderr: string };

/** git を実行する（シェルを通さない）。input があれば stdin に書く */
export function runGit(cwd: string, args: string[], input?: string): Promise<GitRunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', [...GIT_BASE_ARGS, ...args], { cwd, env: { ...process.env, GIT_PAGER: 'cat', LC_ALL: 'C' } });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        child.stdout.on('data', (d: Buffer) => out.push(d));
        child.stderr.on('data', (d: Buffer) => err.push(d));
        child.on('error', reject);
        child.on('close', (code) => {
            resolve({ code: code === null ? -1 : code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf-8') });
        });
        if (input !== undefined) child.stdin.end(input);
        else child.stdin.end();
    });
}

async function gitText(cwd: string, args: string[], input?: string): Promise<string> {
    const r = await runGit(cwd, args, input);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
    return r.stdout.toString('utf-8');
}

/** cwd を含むリポジトリのトップレベル。git 管理外なら null */
export async function getRepoRoot(cwd: string): Promise<string | null> {
    const r = await runGit(cwd, ['rev-parse', '--show-toplevel']);
    if (r.code !== 0) return null;
    return r.stdout.toString('utf-8').trim() || null;
}

/** rev をコミットの完全な hash にする。'-' 始まり（オプション扱いになる）や存在しない rev はエラー */
export async function resolveCommit(cwd: string, rev: string): Promise<string> {
    const v = (rev || '').trim();
    if (!v || v.startsWith('-')) throw new Error(`Invalid revision: '${rev}'`);
    const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${v}^{commit}`]);
    if (r.code !== 0) throw new Error(`Unknown revision: '${rev}'`);
    return r.stdout.toString('utf-8').trim();
}

/**
 * 引数の文字列を対象にする。`workbench`（大文字小文字は問わない）はワークベンチ、それ以外はコミット。
 * 範囲（`a..b`・`a..`・`a...b`）は受け付けない（比較したいときは merge commit を作ってそのコミットを指定する）。
 */
export function parseChangeSetTarget(text: string): ChangeSetTarget {
    const t = (text || '').trim();
    if (!t) throw new Error('コミットハッシュを指定してください');
    if (t.toLowerCase() === WORKBENCH_ARG) return { kind: 'workbench' };
    if (t.includes('..')) throw new Error(`範囲は指定できません（コミット 1 つか ${WORKBENCH_ARG}）: '${text}'`);
    return { kind: 'commit', commit: t };
}

/** 対象を hash に解決する。コミットが親を持たない（ルート）なら空ツリーと比べる。ワークベンチは HEAD と作業ツリー */
export async function resolveChangeSetTarget(cwd: string, target: ChangeSetTarget): Promise<ResolvedChangeSet> {
    if (target.kind === 'workbench') {
        return { base: await resolveCommit(cwd, 'HEAD'), head: null };
    }
    const head = await resolveCommit(cwd, target.commit);
    const parent = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${head}^1`]);
    const base = parent.code === 0 ? parent.stdout.toString('utf-8').trim() : EMPTY_TREE_HASH;
    return { base, head };
}

/** --name-status -z の出力 → パスごとの状態 */
function parseNameStatusZ(out: string): { status: ChangeStatus; filePath: string; oldPath?: string }[] {
    const parts = out.split('\0');
    const res: { status: ChangeStatus; filePath: string; oldPath?: string }[] = [];
    let i = 0;
    while (i < parts.length) {
        const code = parts[i];
        if (!code) { i++; continue; }
        const letter = code[0];
        if (letter === 'R' || letter === 'C') {
            const oldPath = parts[i + 1];
            const newPath = parts[i + 2];
            i += 3;
            if (letter === 'R') res.push({ status: 'renamed', filePath: newPath, oldPath });
            else res.push({ status: 'added', filePath: newPath });
            continue;
        }
        const p = parts[i + 1];
        i += 2;
        if (p === undefined) break;
        if (letter === 'A') res.push({ status: 'added', filePath: p });
        else if (letter === 'D') res.push({ status: 'deleted', filePath: p });
        else res.push({ status: 'modified', filePath: p }); // M / T / U 等
    }
    return res;
}

/**
 * 変更ファイル一覧（status・oldPath・binary・hunk）。git diff -M（リネーム検出）。
 * head が null（ワークベンチ）なら base（HEAD）と作業ツリーを比べる（git diff HEAD と同じ。未登録ファイルは含まない）。
 * 並びはパス順。
 */
export async function getChangeSetFiles(cwd: string, range: ResolvedChangeSet): Promise<ChangedFile[]> {
    const revs = range.head ? [range.base, range.head] : [range.base];
    const common = ['diff', '-M', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=dirty'];
    const nameStatus = await gitText(cwd, [...common, '--name-status', '-z', ...revs, '--']);
    const patch = await gitText(cwd, [...common, '--unified=0', '--src-prefix=a/', '--dst-prefix=b/', ...revs, '--']);

    const diffs = parseGitDiffDetailed(patch);
    const byPath = new Map<string, FileDiff>();
    for (const d of diffs) if (!byPath.has(d.filePath)) byPath.set(d.filePath, d);

    const files: ChangedFile[] = parseNameStatusZ(nameStatus).map(e => {
        const d = byPath.get(e.filePath);
        const f: ChangedFile = { filePath: e.filePath, status: e.status, binary: !!(d && d.binary), hunks: d ? d.hunks : [] };
        if (e.oldPath !== undefined) f.oldPath = e.oldPath;
        return f;
    });
    files.sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
    return files;
}

/** rev 時点のファイル内容（git show rev:path）。その時点に無ければ null */
export async function getFileAtRevision(cwd: string, rev: string, filePath: string): Promise<string | null> {
    if (!rev || rev.startsWith('-')) throw new Error(`Invalid revision: '${rev}'`);
    const r = await runGit(cwd, ['show', '--no-textconv', `${rev}:${filePath}`]);
    if (r.code !== 0) return null;
    return r.stdout.toString('utf-8');
}

/** head 時点の内容。head が null（作業ツリー）なら作業ツリーのファイルを読む。無ければ null */
export async function getHeadContent(cwd: string, range: ResolvedChangeSet, filePath: string): Promise<string | null> {
    if (range.head) return getFileAtRevision(cwd, range.head, filePath);
    try { return fs.readFileSync(path.join(cwd, filePath), 'utf-8'); } catch { return null; }
}

/** base 時点の内容（削除ファイル・削除メソッドの表示用）。無ければ null */
export async function getBaseContent(cwd: string, range: ResolvedChangeSet, filePath: string): Promise<string | null> {
    return getFileAtRevision(cwd, range.base, filePath);
}

/**
 * head 時点の内容が作業ツリーと一致するか（パスごと）。head が null なら常に一致。
 * 比較は blob の hash（作業ツリー側は git hash-object で .gitattributes の改行変換等を通す）。
 * 両方に無いファイルは一致、片方にだけ有るファイルは不一致。
 */
export async function getWorktreeMatchMap(cwd: string, head: string | null, filePaths: string[]): Promise<Map<string, boolean>> {
    const res = new Map<string, boolean>();
    if (!head) {
        for (const p of filePaths) res.set(p, true);
        return res;
    }
    if (head.startsWith('-')) throw new Error(`Invalid revision: '${head}'`);
    const unique = Array.from(new Set(filePaths));
    if (unique.length === 0) return res;

    // head 側の blob hash（ls-tree -z: "<mode> <type> <hash>\t<path>"）
    const headHash = new Map<string, string>();
    const tree = await gitText(cwd, ['ls-tree', '-r', '-z', '--full-tree', head, '--', ...unique.map(p => `:(literal)${p}`)]);
    for (const rec of tree.split('\0').filter(Boolean)) {
        const tab = rec.indexOf('\t');
        const meta = rec.substring(0, tab).split(' ');
        if (meta[1] === 'blob') headHash.set(rec.substring(tab + 1), meta[2]);
    }

    // 作業ツリー側の hash（存在するファイルだけ）
    const existing = unique.filter(p => {
        try { return fs.statSync(path.join(cwd, p)).isFile(); } catch { return false; }
    });
    const wtHash = new Map<string, string>();
    if (existing.length > 0) {
        const out = await gitText(cwd, ['hash-object', '--stdin-paths'], existing.join('\n') + '\n');
        const hashes = out.split('\n').filter(Boolean);
        existing.forEach((p, i) => wtHash.set(p, hashes[i]));
    }

    for (const p of unique) {
        const h = headHash.get(p);
        const w = wtHash.get(p);
        res.set(p, h === w);
    }
    return res;
}

/** 1 ファイル版の getWorktreeMatchMap */
export async function isHeadContentSameAsWorktree(cwd: string, head: string | null, filePath: string): Promise<boolean> {
    const m = await getWorktreeMatchMap(cwd, head, [filePath]);
    return m.get(filePath) === true;
}

const CLIENTSIDE_EXTENSIONS = new Set([
    // テンプレート: JS 拡張の TEMPLATE_EXTENSIONS（vscode-javascript-call-hierarchy/src/templateIncludeResolver.ts）と同じ
    '.html', '.htm', '.jsp', '.jspf', '.ftl', '.ftlh', '.mayaa',
    // JS / TS: viewer の detectAnalysisLanguage（src/methodExtractor.ts）が JS / TS 拡張に回す拡張子と同じ
    '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
]);

/**
 * ファイルパスをブロックに分類する。拡張子（大小文字無視）で決め、分類できないものはすべて other。
 * java: .java / clientside: 既存の JS・TS 拡張が扱うテンプレートと JS・TS / xml: .xml / sql: .sql
 */
export function classifyBlock(filePath: string): BlockKind {
    const base = (filePath || '').split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot < 0) return 'other';
    const ext = base.substring(dot).toLowerCase();
    if (ext === '.java') return 'java';
    if (ext === '.xml') return 'xml';
    if (ext === '.sql') return 'sql';
    if (CLIENTSIDE_EXTENSIONS.has(ext)) return 'clientside';
    return 'other';
}

/** ファイルをブロックごとに分ける。全ブロックのキーを持ち、入力の数 = 各配列の長さの合計 */
export function classifyFiles<T extends { filePath: string }>(files: T[]): Record<BlockKind, T[]> {
    const res: Record<BlockKind, T[]> = { java: [], clientside: [], xml: [], sql: [], other: [] };
    for (const f of files) res[classifyBlock(f.filePath)].push(f);
    return res;
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
