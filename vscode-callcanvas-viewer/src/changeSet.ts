/**
 * 変更集合キャンバス（Change Set Canvas）の合成。
 *
 * Java ブロックは解析器（javaCallHierarchy.analyzeChangeSet）が作り、ここではそれに
 * clientside ブロック（JS/TS 拡張の既存 API の結果から、変更関数の島とテンプレートの include の接続を作る）と、
 * ほかのブロック（xml / sql / other）、解析器がグラフに当てなかった Java ファイル
 * （作業ツリー不一致・削除・バイナリ・解析失敗）のファイル単位ウィンドウ、削除メソッドのウィンドウを足して
 * 1 枚にまとめる。契約は README の「変更集合キャンバス（Change Set Canvas）」節。
 *
 * 合成（composeChangeSetCanvas）は I/O を持たない。git の I/O は generateChangeSetCanvas が行い、
 * Java・clientside の解析は呼び出し側（changeSetCommand.ts）が関数で渡す。vscode の API は使わない。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    BLOCK_ORDER, BlockKind, ChangedFile, ChangeSetTarget, DiffHunk, ResolvedChangeSet,
    classifyBlock, getChangeSetFiles, getFileAtRevision, getWorktreeMatchMap, resolveChangeSetTarget
} from './gitUtils';
import { detectAnalysisLanguage } from './methodExtractor';

/** 合成への入力 1 ファイル分（git 層の ChangedFile に内容と判定を足したもの） */
export type ChangeSetFileInput = ChangedFile & {
    /** head 時点の内容が作業ツリーと一致するか（head が null なら常に true） */
    worktreeMatches: boolean;
    /** 表示に使う新しい側の内容（一致なら作業ツリー、不一致なら head 時点）。削除・バイナリは null */
    headContent?: string | null;
    /** base 時点の内容（削除ファイル・削除メソッドの判定に使う。リネームは旧パスの内容） */
    baseContent?: string | null;
};

/** javaCallHierarchy.analyzeChangeSet の戻り値。unindexedFiles はインデックスのソース外（src/test/java 等）で解析器に渡さなかったファイル（入力の path） */
export type JavaChangeSetResult = { success: boolean; data?: any; error?: string; unindexedFiles?: string[] };

/** 解析器への入力の 1 ファイル（app/README.md の「変更集合キャンバス」入力と同じ形） */
export type JavaChangeSetRequestFile = {
    path: string;
    oldPath?: string;
    status: string;
    worktreeMatches: boolean;
    binary: boolean;
    hunks: DiffHunk[];
};

export type ComposeChangeSetParams = {
    /** commit = そのコミットの変更、workbench = 未コミットの変更、live = ライブ（metadata.changeSet.kind） */
    kind: ChangeSetTarget['kind'];
    /** 対象コミットの完全な hash（workbench・live は null） */
    commit: string | null;
    /** 比較元の完全な hash（コミットの第 1 親・ルートは空ツリー、workbench は HEAD、live は始めたときに決めた base） */
    base: string;
    /** live だけ: 作業ツリーのスナップショット（tree の hash） */
    head?: string;
    files: ChangeSetFileInput[];
    /** Java の解析結果。Java ファイルが無い・拡張が無いときは null */
    java: JavaChangeSetResult | null;
    /** clientside の解析結果（JS/TS 拡張の既存 API を呼んだ結果）。clientside の解析対象が無い・未実行なら null */
    clientside?: ClientsideChangeSetResult | null;
    /** 解析器のウィンドウの filePath を、ほかのウィンドウと同じ基準（リポジトリのトップレベル相対）にそろえる */
    normalizeFilePath?: (filePath: string) => string;
};

export type ComposeChangeSetResult = {
    canvas: any;
    /** Java の解析が失敗・未実行で、Java ファイルをファイル単位で出したときの理由 */
    javaError?: string;
    /** clientside の解析に失敗したファイルがあり、ファイル単位で出したときの理由 */
    clientsideError?: string;
};

const JAVA_BLOCK_ID = 'blk-java';
const CLIENTSIDE_BLOCK_ID = 'blk-clientside';

const BLOCK_LABELS: Record<BlockKind, string> = {
    java: 'Java',
    clientside: 'Clientside (HTML/JS/TS)',
    xml: 'XML',
    sql: 'SQL',
    other: 'その他',
};

/** ブロックのグループ ID（Java は解析器と同じ blk-java） */
export function blockGroupId(kind: BlockKind): string {
    return `blk-${kind}`;
}

/** 変更集合キャンバスか（metadata.changeSet を持つ） */
export function isChangeSetCanvas(json: any): boolean {
    const m = json && json.metadata;
    return !!(m && typeof m === 'object' && m.changeSet && typeof m.changeSet === 'object');
}

/** 解析器へ渡す入力（Java ファイルだけ） */
export function buildJavaChangeSetRequest(files: ChangeSetFileInput[]): JavaChangeSetRequestFile[] {
    return files
        .filter(f => classifyBlock(f.filePath) === 'java')
        .map(f => {
            const r: JavaChangeSetRequestFile = {
                path: f.filePath,
                status: f.status,
                worktreeMatches: f.worktreeMatches,
                binary: f.binary,
                hunks: f.hunks,
            };
            if (f.oldPath !== undefined) r.oldPath = f.oldPath;
            return r;
        });
}

/**
 * 保存ファイル名に使う短い名前（callcanvas_changeset_<名前>.json）。コミットは hash の先頭 8 文字、ワークベンチは workbench、
 * ライブは live_<base の先頭 8 文字>（作り直しても同じファイル＝同じキャンバス）
 */
export function changeSetShortName(commit: string | null, liveBase?: string): string {
    if (liveBase) return `live_${liveBase.substring(0, 8)}`;
    return commit ? commit.substring(0, 8) : 'workbench';
}

function hashId(prefix: string, key: string): string {
    return prefix + crypto.createHash('sha1').update(key).digest('hex').substring(0, 12);
}

function baseName(p: string): string {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

// ---------------------------------------------------------------------------
// 削除メソッド（base にしか無いメソッド）の判定
// ---------------------------------------------------------------------------

export type JavaMethodSpan = {
    /** 名前と引数の型（`name(String,int)`）。オーバーロードを区別する */
    key: string;
    name: string;
    /** 1 始まり。直上のアノテーション行を含む */
    startLine: number;
    endLine: number;
    text: string;
};

/** 宣言の名前の直前に来ない語（`return foo(` 等は呼び出し） */
const STATEMENT_KEYWORDS = new Set(['return', 'new', 'throw', 'else', 'case', 'yield', 'assert', 'await']);
const CONTROL_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'try', 'do', 'super', 'this']);

/** コメント・文字列・文字リテラルを空白にした行（波括弧・括弧の数え上げ用。長さは保つ） */
function maskJava(lines: string[]): string[] {
    const out: string[] = [];
    let inBlock = false;
    let inTextBlock = false;
    for (const line of lines) {
        let r = '';
        let i = 0;
        while (i < line.length) {
            if (inBlock) {
                const end = line.indexOf('*/', i);
                if (end < 0) { r += ' '.repeat(line.length - i); i = line.length; }
                else { r += ' '.repeat(end + 2 - i); i = end + 2; inBlock = false; }
                continue;
            }
            if (inTextBlock) {
                const end = line.indexOf('"""', i);
                if (end < 0) { r += ' '.repeat(line.length - i); i = line.length; }
                else { r += ' '.repeat(end + 3 - i); i = end + 3; inTextBlock = false; }
                continue;
            }
            const ch = line[i];
            const two = line.substring(i, i + 2);
            if (two === '//') { r += ' '.repeat(line.length - i); break; }
            if (two === '/*') { inBlock = true; r += '  '; i += 2; continue; }
            if (line.substring(i, i + 3) === '"""') { inTextBlock = true; r += '   '; i += 3; continue; }
            if (ch === '"' || ch === '\'') {
                let j = i + 1;
                while (j < line.length && line[j] !== ch) { if (line[j] === '\\') j++; j++; }
                r += ' '.repeat(Math.min(j + 1, line.length) - i);
                i = j + 1;
                continue;
            }
            r += ch;
            i++;
        }
        out.push(r);
    }
    return out;
}

function normalizeParamTypes(params: string): string {
    // ジェネリクス・アノテーション・final を外し、各引数の型だけを残す
    let p = params;
    let prev = '';
    while (p !== prev) { prev = p; p = p.replace(/<[^<>]*>/g, ''); }
    p = p.replace(/@\w+(\.\w+)*(\([^)]*\))?/g, ' ').replace(/\bfinal\b/g, ' ');
    return p.split(',').map(x => x.trim()).filter(Boolean).map(x => {
        const tokens = x.replace(/\s*(\[\s*\])/g, '[]').replace(/\s*\.\.\.\s*/g, '... ').split(/\s+/).filter(Boolean);
        if (tokens.length <= 1) return tokens.join('');
        const type = tokens.slice(0, -1).join('');
        const nameArr = (tokens[tokens.length - 1].match(/(\[\])+$/) || [''])[0];
        return (type + nameArr).replace(/\.\.\.$/, '[]');
    }).map(t => t.replace(/^.*\./, '')).join(',');
}

/**
 * Java ソースのメソッド・コンストラクタを大まかに切り出す（削除メソッドの判定用。完全な構文解析ではない）。
 * 宣言の `{` から対応する `}` までを 1 メソッドとし、抽象メソッド・インタフェースの宣言（`;` で終わる）も拾う。
 */
export function extractJavaMethods(content: string): JavaMethodSpan[] {
    const lines = content.split('\n').map(l => l.replace(/\r$/, ''));
    const masked = maskJava(lines);
    const res: JavaMethodSpan[] = [];
    // 行頭のアノテーションを除いた「修飾子・型 名前(」。型が無いのは大文字始まり（コンストラクタ）のときだけ
    const declRe = /^((?:[\w$<>\[\],.?]+\s+)*)([A-Za-z_$][\w$]*)\s*\(/;
    let i = 0;
    while (i < masked.length) {
        const lead = masked[i].length - masked[i].trimStart().length;
        let rest = masked[i].trim();
        let annLen = 0;
        for (;;) {
            const a = rest.match(/^@[\w$.]+\s*(\([^()]*\))?\s*/);
            if (!a || a[0].length === 0) break;
            annLen += a[0].length;
            rest = rest.substring(a[0].length);
        }
        const m = rest.match(declRe);
        const prefixTokens = m ? m[1].trim().split(/\s+/).filter(Boolean) : [];
        const lastToken = prefixTokens[prefixTokens.length - 1] || '';
        if (!m || CONTROL_NAMES.has(m[2]) || STATEMENT_KEYWORDS.has(lastToken) || STATEMENT_KEYWORDS.has(m[2])
            || (prefixTokens.length === 0 && !/^[A-Z]/.test(m[2]))) {
            i++;
            continue;
        }

        // 引数リスト（対応する ')' まで）と、その後の '{'（本体）か ';'（抽象）を探す
        let c = lead + annLen + m[0].length - 1; // '(' の位置
        let j = i;
        let depth = 0;
        let params = '';
        let closed = false;
        let bodyLine = -1;
        let bodyCol = -1;
        let abstractEnd = -1;
        scan:
        for (; j < masked.length && j < i + 40; j++, c = 0) {
            const ml = masked[j];
            for (; c < ml.length; c++) {
                const ch = ml[c];
                if (!closed) {
                    if (ch === '(') { if (depth > 0) params += ch; depth++; }
                    else if (ch === ')') { depth--; if (depth === 0) closed = true; else params += ch; }
                    else params += ch;
                } else if (ch === '{') { bodyLine = j; bodyCol = c; break scan; }
                else if (ch === ';') { abstractEnd = j; break scan; }
                else if (ch === '=' || ch === '(' || ch === ')' || ch === '}' || ch === '-' || ch === '.' && !/[\w$]/.test(ml[c + 1] || '')) { break scan; }
            }
            if (!closed) params += ' ';
        }
        if (bodyLine < 0 && abstractEnd < 0) { i++; continue; }

        let endLine = abstractEnd;
        if (bodyLine >= 0) {
            let braces = 0;
            braces:
            for (let k = bodyLine; k < masked.length; k++) {
                for (let cc = (k === bodyLine ? bodyCol : 0); cc < masked[k].length; cc++) {
                    if (masked[k][cc] === '{') braces++;
                    else if (masked[k][cc] === '}' && --braces === 0) { endLine = k; break braces; }
                }
            }
            if (endLine < 0) { i++; continue; }
        }
        let start = i;
        while (start > 0 && masked[start - 1].trim().startsWith('@')) start--;
        res.push({
            key: `${m[2]}(${normalizeParamTypes(params)})`,
            name: m[2],
            startLine: start + 1,
            endLine: endLine + 1,
            text: lines.slice(start, endLine + 1).join('\n'),
        });
        // 本体の中（ローカルクラス・匿名クラス）は見ない
        i = endLine + 1;
    }
    return res;
}

/** base にあって new に無いメソッド（同じ key のオーバーロードは数で比べる） */
export function findDeletedMethods(baseContent: string, newContent: string): JavaMethodSpan[] {
    const remaining = new Map<string, number>();
    for (const m of extractJavaMethods(newContent)) remaining.set(m.key, (remaining.get(m.key) || 0) + 1);
    const res: JavaMethodSpan[] = [];
    for (const m of extractJavaMethods(baseContent)) {
        const n = remaining.get(m.key) || 0;
        if (n > 0) remaining.set(m.key, n - 1);
        else res.push(m);
    }
    return res;
}

// ---------------------------------------------------------------------------
// clientside（HTML/JS/TS）の変更関数の島
// ---------------------------------------------------------------------------
//
// 既存の JS/TS 拡張の API をそのまま使う（再実装しない）:
//   - 関数範囲の解決: jsCallHierarchy / tsCallHierarchy の resolveMethodSignature(s)（行を含む最も内側の関数）
//   - 呼び出し関係: analyzeMethod（関数起点の下向き BFS。深さは各拡張の設定 jsCallHierarchy.depth / tsCallHierarchy.depth）
//   - テンプレート間: jsCallHierarchy.collectIncludeEdges（Export HTML Include Map と同じ辺）
// 既存 API は下向き（outgoing）だけなので、共通の呼び出し元（junction）は作らない。

/** clientside の解析への入力 1 ファイル（JS/TS の関数解決か、テンプレートの include 辺の取得） */
export type ClientsideRequestFile = {
    path: string;
    /** javascript → jsCallHierarchy.*、typescript → tsCallHierarchy.*（viewer の detectAnalysisLanguage と同じ使い分け）、template → include 辺だけ */
    kind: 'javascript' | 'typescript' | 'template';
    /** 関数を解決する行（JS/TS のみ。hunk が触れる新側の行） */
    lines: number[];
};

/** analyzeMethod の戻り値（CallCanvas JSON） */
export type ClientsideAnalysis = { success: boolean; data?: any; error?: string };

/** clientside の解析結果（呼び出し側が JS/TS 拡張の API を呼んで集めたもの。合成はこれだけを見る） */
export type ClientsideChangeSetResult = {
    /** 入力 path → 行（文字列）→ その行を含む関数のシグネチャ（無ければ null）。解決できなかったファイルは入れない */
    lineSignatures: Record<string, Record<string, string | null>>;
    /** clientsideSeedKey(path, signature) → analyzeMethod の結果 */
    analyses: Record<string, ClientsideAnalysis>;
    /** 変更テンプレートの include 辺（入力 path。from が to を include する。line は include の行） */
    includeEdges: Array<{ from: string; to: string; line: number }>;
    /** include 辺の節点の内容（入力と同じ基準の path → 全文）。未変更テンプレートの via ウィンドウに使う */
    templateContents?: Record<string, string>;
    /** include 辺を集められたテンプレート（入力 path） */
    templatesAnalyzed?: string[];
    /** 解析できなかったファイル（入力 path → 理由） */
    errors?: Record<string, string>;
};

/** analyses のキー */
export function clientsideSeedKey(filePath: string, signature: string): string {
    return `${filePath}\n${signature}`;
}

/** 解析器（Java）の Hunk.touches と同じ: 新側で触れる行。削除だけの hunk は newStart と newStart+1（その間の削除） */
export function hunkTouchedLines(h: DiffHunk): number[] {
    if (h.newCount > 0) {
        const res: number[] = [];
        for (let l = h.newStart; l < h.newStart + h.newCount; l++) res.push(l);
        return res;
    }
    return [h.newStart, h.newStart + 1];
}

/** 解析に回す clientside のファイル（削除・バイナリ・作業ツリー不一致は回さない＝今まで通りファイル単位） */
export function buildClientsideRequest(files: ChangeSetFileInput[]): ClientsideRequestFile[] {
    const res: ClientsideRequestFile[] = [];
    for (const f of files) {
        if (classifyBlock(f.filePath) !== 'clientside') continue;
        if (f.status === 'deleted' || f.binary || !f.worktreeMatches) continue;
        const lang = detectAnalysisLanguage(f.filePath);
        if (lang === 'javascript' || lang === 'typescript') {
            const lines = new Set<number>();
            for (const h of f.hunks) for (const l of hunkTouchedLines(h)) if (l > 0) lines.add(l);
            res.push({ path: f.filePath, kind: lang, lines: Array.from(lines).sort((a, b) => a - b) });
        } else {
            res.push({ path: f.filePath, kind: 'template', lines: [] });
        }
    }
    return res;
}

/** hunk が当たる関数（シグネチャ）。削除だけの hunk は前後の行が同じ関数のときだけ（解析器の touches と同じ） */
function hunkSignatures(h: DiffHunk, sigs: Record<string, string | null>): string[] {
    const at = (l: number) => sigs[String(l)] || null;
    if (h.newCount === 0) {
        const a = at(h.newStart);
        return a && a === at(h.newStart + 1) ? [a] : [];
    }
    const res: string[] = [];
    for (const l of hunkTouchedLines(h)) {
        const s = at(l);
        if (s && !res.includes(s)) res.push(s);
    }
    return res;
}

/** analyzeMethod の結果 1 つを、節点（キーは正規化したファイルパスと開始行）と下向きの辺にする */
function analysisGraph(data: any, norm: (p: string) => string): { root: string | null; nodes: Map<string, any>; out: Map<string, Array<{ to: string; callLine?: number; callEndLine?: number; callEndCol?: number }>> } {
    const nodes = new Map<string, any>();
    const keyOf = new Map<string, string>();
    for (const w of (Array.isArray(data && data.windows) ? data.windows : [])) {
        if (!w || typeof w.id !== 'string' || typeof w.filePath !== 'string') continue;
        const key = `${norm(w.filePath)}:${w.startLine}`;
        keyOf.set(w.id, key);
        if (!nodes.has(key)) nodes.set(key, w);
    }
    const out = new Map<string, Array<{ to: string; callLine?: number; callEndLine?: number; callEndCol?: number }>>();
    for (const c of (Array.isArray(data && data.connections) ? data.connections : [])) {
        const a = c && keyOf.get(c.from);
        const b = c && keyOf.get(c.to);
        if (!a || !b || a === b) continue;
        const list = out.get(a) || [];
        const edge = { to: b, callLine: c.callLine, callEndLine: c.callEndLine, callEndCol: c.callEndCol };
        const i = list.findIndex(e => e.to === b);
        // 1 組 1 本。TS の入れ子関数は定義の接続（callEndCol 無し）より呼んでいる行の接続を採る（ステップ実行がそこから入る）
        if (i < 0) list.push(edge);
        else if (typeof list[i].callEndCol !== 'number' && typeof c.callEndCol === 'number') list[i] = edge;
        out.set(a, list);
    }
    const rootId = data && data.metadata && data.metadata.analysis && data.metadata.analysis.rootWindowId;
    const rootWin = (typeof rootId === 'string' && keyOf.has(rootId)) ? rootId
        : (Array.isArray(data && data.windows) && data.windows[0] ? data.windows[0].id : null);
    return { root: rootWin ? keyOf.get(rootWin) || null : null, nodes, out };
}

/** 解析結果のウィンドウを変更集合のウィンドウにする（位置・ID は持ち込まない） */
function fromAnalysisWindow(w: any, id: string, group: string, windowType: string, norm: (p: string) => string): any {
    const { id: _id, x: _x, y: _y, position: _p, width: _w, height: _h, collapsed: _c, visible: _v, ...rest } = w;
    return { ...rest, id, group, windowType, filePath: norm(w.filePath) };
}

type ClientsideComposeOutput = {
    groups: any[];
    connections: any[];
    /** 入力 path → この合成で作ったウィンドウ ID・inGraph・reason */
    files: Map<string, { inGraph: boolean; reason?: string; windows: string[] }>;
    symbolIndex?: Record<string, any>;
    error?: string;
};

/**
 * clientside ブロックの合成。Java の島（ChangeSetAnalyzer）と同じ考え方:
 * hunk が当たる関数を種にし、各種の analyzeMethod（下向き）で別の種へ届く最短経路を島の接続にする
 * （経路上の未変更の関数は via、種に着いたらその先は辿らない、共有する via は 1 つ）。つながらない種は単独の島。
 * 関数に当たらない hunk はファイル全文のファイル単位ウィンドウ（outsideMethod）。
 * 変更テンプレートどうしは include 辺で結ぶ（テンプレートはファイル単位ウィンドウのまま島に入れる）。
 * 解析できなかったファイルは今まで通りファイル単位ウィンドウ（漏れなし）。
 */
function composeClientside(
    files: ChangeSetFileInput[],
    result: ClientsideChangeSetResult | null | undefined,
    norm: (p: string) => string,
    addCanvasWindow: (w: any) => string,
): ClientsideComposeOutput {
    const out: ClientsideComposeOutput = { groups: [], connections: [], files: new Map() };
    const created = new Map<string, any>();
    const addWindow = (w: any): string => {
        const id = addCanvasWindow(w);
        created.set(id, w);
        return id;
    };
    const requested = new Map<string, ClientsideRequestFile>(buildClientsideRequest(files).map(r => [r.path, r]));
    const errors: string[] = [];
    const lineSigs = (result && result.lineSignatures) || {};
    const analyses = (result && result.analyses) || {};

    // 1. hunk → 変更関数（種）。種の解析が 1 つでも失敗したファイルはファイル単位に戻す
    type Seed = { key: string; file: ChangeSetFileInput; hunks: DiffHunk[]; graph: ReturnType<typeof analysisGraph>; data: any };
    const seeds = new Map<string, Seed>();
    const outsideHunks = new Map<string, DiffHunk[]>();
    const graphFiles = new Set<string>();
    for (const f of files) {
        const req = requested.get(f.filePath);
        if (!req || req.kind === 'template') continue;
        const sigs = lineSigs[f.filePath];
        if (!result || !sigs) {
            const why = (result && result.errors && result.errors[f.filePath]) || (result ? '関数を解決できませんでした' : `${req.kind === 'typescript' ? 'TypeScript' : 'JavaScript'} Call Hierarchy 拡張がありません`);
            errors.push(`${f.filePath}: ${why}`);
            continue;
        }
        const local = new Map<string, Seed>();
        const outside: DiffHunk[] = [];
        let failed: string | null = null;
        for (const h of f.hunks) {
            const hit = hunkSignatures(h, sigs);
            if (hit.length === 0) { outside.push(h); continue; }
            for (const sig of hit) {
                let seed = local.get(sig);
                if (!seed) {
                    const a = analyses[clientsideSeedKey(f.filePath, sig)];
                    const g = a && a.success && a.data ? analysisGraph(a.data, norm) : null;
                    if (!g || !g.root) { failed = failed || `${sig}: ${(a && a.error) || '解析結果がありません'}`; continue; }
                    seed = { key: g.root, file: f, hunks: [], graph: g, data: a!.data };
                    local.set(sig, seed);
                }
                if (!seed.hunks.includes(h)) seed.hunks.push(h);
            }
        }
        if (failed) { errors.push(`${f.filePath}: ${failed}`); continue; }
        graphFiles.add(f.filePath);
        for (const seed of local.values()) {
            const prev = seeds.get(seed.key);
            if (prev) { for (const h of seed.hunks) if (!prev.hunks.includes(h)) prev.hunks.push(h); }
            else seeds.set(seed.key, seed);
        }
        if (outside.length > 0) outsideHunks.set(f.filePath, outside);
    }

    // 2. 種どうしの連結（下向きの最短経路のみ。種に着いたらその先は辿らない）
    const seedKeys = Array.from(seeds.keys());
    const parent = seedKeys.map((_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) { if (ra < rb) parent[rb] = ra; else parent[ra] = rb; } };
    const idx = new Map<string, number>(seedKeys.map((k, i) => [k, i]));
    type Link = { path: string[]; calls: Array<{ callLine?: number; callEndLine?: number; callEndCol?: number }>; nodes: Map<string, any> };
    const links: Link[] = [];
    for (const s of seedKeys) {
        const g = seeds.get(s)!.graph;
        const prev = new Map<string, { from: string | null; call?: { callLine?: number; callEndLine?: number; callEndCol?: number } }>([[s, { from: null }]]);
        const q: string[] = [s];
        while (q.length > 0) {
            const u = q.shift()!;
            for (const e of (g.out.get(u) || [])) {
                if (prev.has(e.to)) continue;
                prev.set(e.to, { from: u, call: { callLine: e.callLine, callEndLine: e.callEndLine, callEndCol: e.callEndCol } });
                if (seeds.has(e.to)) {
                    const p: string[] = [];
                    const calls: Array<{ callLine?: number; callEndLine?: number; callEndCol?: number }> = [];
                    for (let n: string | null = e.to; n !== null; n = prev.get(n)!.from) {
                        p.unshift(n);
                        const c = prev.get(n)!.call;
                        if (c) calls.unshift(c);
                    }
                    links.push({ path: p, calls, nodes: g.nodes });
                    union(idx.get(s)!, idx.get(e.to)!);
                    continue;
                }
                q.push(e.to);
            }
        }
    }

    // 3. 島（連結成分。順は最初の種の順）
    const components = new Map<number, string[]>();
    for (const s of seedKeys) {
        const r = find(idx.get(s)!);
        if (!components.has(r)) components.set(r, []);
        components.get(r)!.push(s);
    }
    const islandOf = new Map<string, string>();
    let islandNo = 0;
    for (const members of components.values()) {
        const id = `cs-isl-${++islandNo}`;
        for (const m of members) islandOf.set(m, id);
        const first = seeds.get(members[0])!;
        const name = (first.graph.nodes.get(first.key) || {}).displayName || first.key;
        out.groups.push({ id, kind: 'island', parent: CLIENTSIDE_BLOCK_ID, label: `島 ${islandNo}: ${name}${members.length > 1 ? ' …' : ''}` });
    }
    const viaNodes = new Map<string, any>();
    for (const l of links) {
        const island = islandOf.get(l.path[l.path.length - 1])!;
        for (const v of l.path.slice(1, -1)) {
            if (!islandOf.has(v)) islandOf.set(v, island);
            if (!viaNodes.has(v)) viaNodes.set(v, l.nodes.get(v));
        }
    }

    // 4. ウィンドウ（島ごとに 種 → 中継 の順）
    const windowIdOf = new Map<string, string>();
    const fileWins = (p: string) => {
        if (!out.files.has(p)) out.files.set(p, { inGraph: true, windows: [] });
        return out.files.get(p)!;
    };
    for (const members of components.values()) {
        for (const k of members) {
            const seed = seeds.get(k)!;
            const w = fromAnalysisWindow(seed.graph.nodes.get(k), hashId('cm-', `seed:${k}`), islandOf.get(k)!, 'method', norm);
            const change: any = { status: seed.file.status };
            if (seed.file.oldPath !== undefined) change.oldPath = seed.file.oldPath;
            change.source = 'worktree';
            w.change = change;
            w.diffState = { hunks: seed.hunks };
            const id = addWindow(w);
            windowIdOf.set(k, id);
            fileWins(seed.file.filePath).windows.push(id);
        }
        const island = islandOf.get(members[0]);
        for (const [v, win] of viaNodes) {
            if (islandOf.get(v) !== island || windowIdOf.has(v) || !win) continue;
            windowIdOf.set(v, addWindow(fromAnalysisWindow(win, hashId('cv-', `via:${v}`), island!, 'via', norm)));
        }
    }
    // 関数外の hunk はファイル全文のファイル単位ウィンドウ 1 つ（Java のメソッド外と同じ）
    for (const f of files) {
        if (!graphFiles.has(f.filePath)) continue;
        const outside = outsideHunks.get(f.filePath);
        const entry = fileWins(f.filePath);
        if (outside || entry.windows.length === 0) {
            const w = makeFileWindows({ ...f, hunks: outside || f.hunks }, CLIENTSIDE_BLOCK_ID,
                outside ? { flags: ['outsideMethod'], label: 'メソッド外の変更' } : {})[0];
            entry.windows.push(addWindow(w));
        }
    }

    // 5. 接続（1 段ずつ実線。共有する区間は 1 本）
    const added = new Set<string>();
    for (const l of links) {
        for (let i = 0; i + 1 < l.path.length; i++) {
            const from = windowIdOf.get(l.path[i]);
            const to = windowIdOf.get(l.path[i + 1]);
            if (!from || !to || added.has(`${from}->${to}`)) continue;
            added.add(`${from}->${to}`);
            const c: any = { from, to };
            const call = l.calls[i];
            if (call && typeof call.callLine === 'number') {
                c.callLine = call.callLine;
                if (typeof call.callEndLine === 'number') c.callEndLine = call.callEndLine;
                if (typeof call.callEndCol === 'number') c.callEndCol = call.callEndCol;
            }
            out.connections.push(c);
        }
    }

    // 解析できなかった JS/TS は今まで通りファイル単位（理由 analysisFailed）
    for (const f of files) {
        const req = requested.get(f.filePath);
        if (!req || req.kind === 'template' || graphFiles.has(f.filePath)) continue;
        const w = makeFileWindows(f, CLIENTSIDE_BLOCK_ID, { label: '解析に失敗したためグラフ外' })[0];
        out.files.set(f.filePath, { inGraph: false, reason: 'analysisFailed', windows: [addWindow(w)] });
    }

    // 6. テンプレート: ファイル単位ウィンドウ。変更テンプレートを起点に include 辺（collectIncludeEdges が辿った範囲）を
    //    下向きに辿り、別の変更テンプレートに届く最短経路を島の接続にする（Java/JS と同じ。経路上の未変更テンプレートは
    //    via のファイル単位ウィンドウ（全文）、共有する via は 1 つ、変更テンプレートに着いたらその先は辿らない）
    const templates = files.filter(f => requested.get(f.filePath)?.kind === 'template');
    const analyzedTemplates = new Set<string>((result && result.templatesAnalyzed) || []);
    const tplContents = (result && result.templateContents) || {};
    const tplWindow = new Map<string, string>();
    for (const f of templates) {
        const entry = { inGraph: analyzedTemplates.has(f.filePath), windows: [] as string[] } as { inGraph: boolean; reason?: string; windows: string[] };
        if (!entry.inGraph) {
            const why = result && result.errors && result.errors[f.filePath];
            if (why) { entry.reason = 'analysisFailed'; errors.push(`${f.filePath}: ${why}`); }
        }
        const id = addWindow(makeFileWindows(f, CLIENTSIDE_BLOCK_ID, {})[0]);
        entry.windows.push(id);
        tplWindow.set(f.filePath, id);
        out.files.set(f.filePath, entry);
    }
    // ほかの変更ファイル（削除・作業ツリー不一致等で include を訊かなかったもの）は中継にしない（窓が二重になるため）
    const changedPaths = new Set(files.map(f => f.filePath));
    const tplOut = new Map<string, Array<{ to: string; line: number }>>();
    for (const e of ((result && result.includeEdges) || [])) {
        if (!e || e.from === e.to) continue;
        const list = tplOut.get(e.from) || [];
        if (!list.some(x => x.to === e.to)) list.push({ to: e.to, line: e.line });
        tplOut.set(e.from, list);
    }
    const tplSeeds = templates.map(f => f.filePath).filter(p => analyzedTemplates.has(p));
    const tp = new Map<string, string>(tplSeeds.map(p => [p, p]));
    const tfind = (x: string): string => { while (tp.get(x) !== x) x = tp.get(x)!; return x; };
    const tplLinks: Array<{ path: string[]; lines: number[] }> = [];
    for (const s of tplSeeds) {
        const prev = new Map<string, { from: string | null; line?: number }>([[s, { from: null }]]);
        const q: string[] = [s];
        while (q.length > 0) {
            const u = q.shift()!;
            for (const e of (tplOut.get(u) || [])) {
                if (prev.has(e.to)) continue;
                prev.set(e.to, { from: u, line: e.line });
                if (tp.has(e.to)) {
                    const p: string[] = [];
                    const lines: number[] = [];
                    for (let n: string | null = e.to; n !== null; n = prev.get(n)!.from) {
                        p.unshift(n);
                        const l = prev.get(n)!.line;
                        if (l !== undefined) lines.unshift(l);
                    }
                    tplLinks.push({ path: p, lines });
                    const ra = tfind(s), rb = tfind(e.to);
                    if (ra !== rb) { if (tplSeeds.indexOf(ra) < tplSeeds.indexOf(rb)) tp.set(rb, ra); else tp.set(ra, rb); }
                    continue;
                }
                if (changedPaths.has(e.to)) continue;
                q.push(e.to);
            }
        }
    }
    if (tplLinks.length > 0) {
        const tplIsland = new Map<string, string>();
        const islandOfTpl = new Map<string, string>();
        for (const p of tplSeeds) {
            const r = tfind(p);
            if (!tplLinks.some(l => tfind(l.path[0]) === r)) continue;
            if (!tplIsland.has(r)) {
                const id = `cs-isl-${++islandNo}`;
                tplIsland.set(r, id);
                out.groups.push({ id, kind: 'island', parent: CLIENTSIDE_BLOCK_ID, label: `島 ${islandNo}: ${baseName(r)} …` });
            }
            islandOfTpl.set(p, tplIsland.get(r)!);
            const w = created.get(tplWindow.get(p)!);
            if (w) w.group = tplIsland.get(r);
        }
        const tplWinOf = new Map<string, string>(tplWindow);
        for (const l of tplLinks) {
            const island = islandOfTpl.get(l.path[0])!;
            for (const v of l.path.slice(1, -1)) {
                if (tplWinOf.has(v)) continue;
                const content = tplContents[v];
                tplWinOf.set(v, addWindow({
                    id: hashId('tv-', `via:${v}`),
                    group: island,
                    windowType: 'via',
                    displayName: baseName(v),
                    filePath: v,
                    startLine: 1,
                    code: typeof content === 'string' ? content.replace(/\r?\n$/, '') : '',
                }));
            }
        }
        const addedTpl = new Set<string>();
        for (const l of tplLinks) {
            for (let i = 0; i + 1 < l.path.length; i++) {
                const from = tplWinOf.get(l.path[i]);
                const to = tplWinOf.get(l.path[i + 1]);
                if (!from || !to || addedTpl.has(`${from}->${to}`)) continue;
                addedTpl.add(`${from}->${to}`);
                out.connections.push({ from, to, callLine: l.lines[i], callEndLine: l.lines[i] });
            }
        }
    }

    // TS 拡張の定数表（symbolIndex）は既存の合流と同じく先勝ちで取り込む
    for (const seed of seeds.values()) {
        const si = seed.data && seed.data.symbolIndex;
        if (!si || typeof si !== 'object') continue;
        out.symbolIndex = out.symbolIndex || {};
        for (const [k, v] of Object.entries(si)) if (!(k in out.symbolIndex)) out.symbolIndex[k] = v;
    }
    if (errors.length > 0) out.error = `clientside の解析に失敗したファイルはファイル単位で表示します: ${errors.join(' / ')}`;
    return out;
}

// ---------------------------------------------------------------------------
// 合成
// ---------------------------------------------------------------------------

type FileEntry = {
    path: string;
    oldPath?: string;
    status: string;
    block: BlockKind;
    inGraph: boolean;
    reason?: string;
    windows: string[];
};

function hasRemovedLines(hunks: DiffHunk[]): boolean {
    return hunks.some(h => h.lines.some(l => l.type === 'remove'));
}

/** 解析器の結果の path（相対・絶対・区切り違い）を入力の path に当てる */
function matchResultPath(resultPath: string, inputPaths: string[]): string | null {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
    const rp = norm(resultPath || '');
    for (const p of inputPaths) if (norm(p) === rp) return p;
    for (const p of inputPaths) if (rp.endsWith('/' + norm(p))) return p;
    return null;
}

/**
 * ファイル単位ウィンドウ（windowType: "file"）を作る。
 * 削除 = base 時点の内容（差分なし）/ バイナリ = 内容なし / それ以外 = 新しい側の全文に hunk を付ける。
 */
function makeFileWindows(f: ChangeSetFileInput, group: string, opts: { flags?: string[]; label?: string }): any[] {
    const make = (startLine: number, idKey: string): any => {
        const change: any = { status: f.status };
        if (f.oldPath !== undefined) change.oldPath = f.oldPath;
        return {
            id: hashId('f-', idKey),
            group,
            windowType: 'file',
            displayName: baseName(f.filePath),
            filePath: f.filePath,
            startLine,
            code: '',
            change,
        };
    };
    const finish = (w: any, flags: string[]): any => {
        if (flags.length > 0) w.change.flags = flags;
        return w;
    };
    const flags = [...(opts.flags || [])];
    if (f.status === 'deleted') {
        const w = make(1, `file:${f.filePath}`);
        w.change.source = 'base';
        if (!flags.includes('deleted')) flags.push('deleted');
        w.code = (f.baseContent || '').replace(/\r?\n$/, '');
        w.change.label = opts.label || '削除（base 時点の内容）';
        return [finish(w, flags)];
    }
    if (f.binary) {
        const w = make(1, `file:${f.filePath}`);
        w.change.source = f.worktreeMatches ? 'worktree' : 'head';
        if (!flags.includes('binary')) flags.push('binary');
        w.change.label = opts.label || 'バイナリ（内容は表示しない）';
        return [finish(w, flags)];
    }
    const source = f.worktreeMatches ? 'worktree' : 'head';
    const lines = (f.headContent || '').replace(/\r?\n$/, '').split('\n');
    const w = make(1, `file:${f.filePath}`);
    w.change.source = source;
    w.code = lines.join('\n');
    if (f.hunks.length > 0) w.diffState = { hunks: f.hunks };
    if (opts.label) w.change.label = opts.label;
    return [finish(w, flags)];
}

/**
 * 変更集合キャンバスを 1 枚に合成する。
 * - groups の順は BLOCK_ORDER（Java の島は blk-java の直後に解析器の順で）。変更の無いブロックは出さない
 * - metadata.changeSet.files は入力の全ファイル（各 windows は空でない）
 * - Java の解析が失敗・未実行なら、Java ファイルもすべてファイル単位ウィンドウにする（漏れなし）
 * - clientside の島は blk-clientside の直後。解析できなかった JS/TS はファイル単位ウィンドウ（漏れなし）
 */
export function composeChangeSetCanvas(params: ComposeChangeSetParams): ComposeChangeSetResult {
    let javaError: string | undefined;
    const files = params.files;
    const byBlock: Record<BlockKind, ChangeSetFileInput[]> = { java: [], clientside: [], xml: [], sql: [], other: [] };
    for (const f of files) byBlock[classifyBlock(f.filePath)].push(f);

    const javaFiles = byBlock.java;
    const java = params.java;
    const javaOk = !!(java && java.success && java.data && typeof java.data === 'object');
    if (javaFiles.length > 0 && !javaOk) {
        javaError = `Java の変更集合解析に失敗したため、Java ファイルはファイル単位で表示します: ${(java && java.error) || 'Java Call Hierarchy 拡張がありません'}`;
    }

    const data = javaOk ? java!.data : {};
    const windows: any[] = javaOk && Array.isArray(data.windows) ? data.windows.slice() : [];
    const connections: any[] = javaOk && Array.isArray(data.connections) ? data.connections.slice() : [];
    const javaGroups: any[] = javaOk && Array.isArray(data.groups) ? data.groups : [];
    const javaCs = (javaOk && data.metadata && data.metadata.changeSet) ? data.metadata.changeSet : {};
    if (params.normalizeFilePath) {
        for (const w of windows) if (w && typeof w.filePath === 'string') w.filePath = params.normalizeFilePath(w.filePath);
    }
    const usedIds = new Set<string>(windows.map(w => w.id));
    const addWindow = (w: any): string => {
        let id = w.id;
        for (let n = 2; usedIds.has(id); n++) id = `${w.id}-${n}`;
        w.id = id;
        usedIds.add(id);
        windows.push(w);
        return id;
    };

    // 解析器の files[] を入力の path に当てる
    const javaPaths = javaFiles.map(f => f.filePath);
    const resultByPath = new Map<string, any>();
    if (javaOk && Array.isArray(javaCs.files)) {
        for (const rf of javaCs.files) {
            const p = matchResultPath(rf && rf.path, javaPaths);
            if (p && !resultByPath.has(p)) resultByPath.set(p, rf);
        }
    }
    const existingIds = new Set<string>(windows.map(w => w.id));
    const unindexed = new Set<string>();
    for (const p of (java && Array.isArray(java.unindexedFiles) ? java.unindexedFiles : [])) {
        const q = matchResultPath(p, javaPaths);
        if (q) unindexed.add(q);
    }

    const entries = new Map<string, FileEntry>();
    const newEntry = (f: ChangeSetFileInput, block: BlockKind): FileEntry => {
        const e: FileEntry = { path: f.filePath, status: f.status, block, inGraph: false, windows: [] };
        if (f.oldPath !== undefined) e.oldPath = f.oldPath;
        return e;
    };

    // ---- Java ----
    for (const f of javaFiles) {
        const e = newEntry(f, 'java');
        const rf = resultByPath.get(f.filePath);
        let reason = f.status === 'deleted' ? 'deleted' : (f.binary ? 'binary' : (!f.worktreeMatches ? 'worktreeMismatch' : undefined));
        if (unindexed.has(f.filePath) && reason !== 'deleted' && reason !== 'binary') reason = 'notIndexed';
        if (rf && rf.inGraph === true && !unindexed.has(f.filePath)) {
            e.inGraph = true;
            e.windows = (Array.isArray(rf.windows) ? rf.windows : []).filter((id: string) => existingIds.has(id));
        } else if (javaOk && rf) {
            e.reason = rf.reason || reason;
        } else {
            // 解析器に渡したのに結果に無い・解析が失敗/未実行 → analysisFailed
            e.reason = reason || 'analysisFailed';
        }
        if (e.windows.length === 0) {
            const label = e.inGraph
                ? undefined
                : (e.reason === 'worktreeMismatch' ? '作業ツリーと不一致のためグラフ外'
                    : e.reason === 'notIndexed' ? 'インデックス外（テスト等）'
                    : e.reason === 'analysisFailed' ? (javaOk ? '解析結果に含まれないためグラフ外' : 'Java 解析に失敗したためグラフ外')
                    : undefined);
            const flags: string[] = [];
            if (e.reason === 'notIndexed') flags.push('notIndexed');
            if (!f.worktreeMatches && f.status !== 'deleted' && !f.binary) flags.push('worktreeMismatch');
            for (const w of makeFileWindows(f, JAVA_BLOCK_ID, { flags, label })) e.windows.push(addWindow(w));
        }
        // 削除メソッド: グラフに当てたファイルで、base にしか無いメソッド
        if (e.inGraph && (f.status === 'modified' || f.status === 'renamed') && f.baseContent && typeof f.headContent === 'string' && hasRemovedLines(f.hunks)) {
            for (const dm of findDeletedMethods(f.baseContent, f.headContent)) {
                const change: any = { status: f.status, source: 'base', flags: ['deletedMethod'], label: '削除メソッド（base 時点の内容）' };
                if (f.oldPath !== undefined) change.oldPath = f.oldPath;
                e.windows.push(addWindow({
                    id: hashId('d-', `deletedMethod:${f.filePath}:${dm.key}`),
                    group: JAVA_BLOCK_ID,
                    windowType: 'file',
                    displayName: `${baseName(f.oldPath || f.filePath).replace(/\.java$/, '')} # ${dm.name}（削除）`,
                    filePath: f.oldPath || f.filePath,
                    startLine: dm.startLine,
                    code: dm.text,
                    change,
                }));
            }
        }
        entries.set(f.filePath, e);
    }

    // ---- clientside（JS/TS の変更関数の島・テンプレートの include。解析できないものはファイル単位） ----
    const cs = composeClientside(byBlock.clientside, params.clientside, params.normalizeFilePath || (p => p), addWindow);
    for (const f of byBlock.clientside) {
        const e = newEntry(f, 'clientside');
        const r = cs.files.get(f.filePath);
        if (r) {
            e.inGraph = r.inGraph;
            if (r.reason) e.reason = r.reason;
            e.windows = r.windows;
        } else {
            const label = (f.status !== 'deleted' && !f.binary && !f.worktreeMatches) ? '作業ツリーと不一致（head 時点の内容）' : undefined;
            for (const w of makeFileWindows(f, blockGroupId('clientside'), { label })) e.windows.push(addWindow(w));
        }
        entries.set(f.filePath, e);
    }

    // ---- xml / sql / other ----
    for (const kind of BLOCK_ORDER) {
        if (kind === 'java' || kind === 'clientside') continue;
        for (const f of byBlock[kind]) {
            const e = newEntry(f, kind);
            const label = (f.status !== 'deleted' && !f.binary && !f.worktreeMatches) ? '作業ツリーと不一致（head 時点の内容）' : undefined;
            for (const w of makeFileWindows(f, blockGroupId(kind), { label })) e.windows.push(addWindow(w));
            entries.set(f.filePath, e);
        }
    }

    // ---- groups（BLOCK_ORDER。Java の島は blk-java の直後） ----
    const groups: any[] = [];
    for (const kind of BLOCK_ORDER) {
        if (byBlock[kind].length === 0) continue;
        if (kind === 'java') {
            const blk = javaGroups.find(g => g && g.id === JAVA_BLOCK_ID);
            groups.push(blk ? { ...blk, kind: 'java' } : { id: JAVA_BLOCK_ID, kind: 'java', label: BLOCK_LABELS.java });
            for (const g of javaGroups) if (g && g.id !== JAVA_BLOCK_ID) groups.push(g);
        } else {
            groups.push({ id: blockGroupId(kind), kind, label: BLOCK_LABELS[kind] });
            if (kind === 'clientside') groups.push(...cs.groups);
        }
    }
    // 所属グループの無いウィンドウ（解析器の想定外）は Java ブロックに入れる
    const groupIds = new Set(groups.map(g => g.id));
    for (const w of windows) {
        if (!w.group || !groupIds.has(w.group)) {
            if (!groupIds.has(JAVA_BLOCK_ID)) {
                groups.unshift({ id: JAVA_BLOCK_ID, kind: 'java', label: BLOCK_LABELS.java });
                groupIds.add(JAVA_BLOCK_ID);
            }
            w.group = JAVA_BLOCK_ID;
        }
    }

    const changeSet: any = {
        kind: params.kind,
        commit: params.commit,
        base: params.base,
    };
    if (params.kind === 'live') changeSet.head = params.head;
    changeSet.files = files.map(f => entries.get(f.filePath)!);

    const canvas: any = {
        autoLayout: true,
        groups,
        windows,
        connections: connections.concat(cs.connections),
    };
    if (javaOk && data.symbols && typeof data.symbols === 'object') canvas.symbols = data.symbols;
    if (cs.symbolIndex) canvas.symbolIndex = cs.symbolIndex;
    canvas.metadata = { changeSet };
    const res: ComposeChangeSetResult = { canvas };
    if (javaError) res.javaError = javaError;
    if (cs.error) res.clientsideError = cs.error;
    return res;
}

/**
 * 契約の不変条件を検査する（空配列なら満たしている）。
 * 入力の全ファイルが files に 1 回ずつ・各 windows が空でなく実在・全 windows[].group が groups に存在・
 * 全接続の両端が同じ島のウィンドウ・groups のブロック順・島の parent が java / clientside ブロック。
 */
/** 島を持てるブロック（Java は解析器の島、clientside は JS/TS の関数・テンプレートの島） */
const ISLAND_PARENT_KINDS = ['java', 'clientside'];

export function validateChangeSetCanvas(canvas: any, inputPaths: string[]): string[] {
    const errors: string[] = [];
    const cs = canvas && canvas.metadata && canvas.metadata.changeSet;
    if (!cs || !Array.isArray(cs.files)) return ['metadata.changeSet.files がありません'];
    const windows: any[] = Array.isArray(canvas.windows) ? canvas.windows : [];
    const winById = new Map<string, any>(windows.map(w => [w.id, w]));
    const groups: any[] = Array.isArray(canvas.groups) ? canvas.groups : [];
    const groupById = new Map<string, any>(groups.map(g => [g.id, g]));

    const seen = new Map<string, number>();
    for (const f of cs.files) seen.set(f.path, (seen.get(f.path) || 0) + 1);
    for (const p of inputPaths) {
        const n = seen.get(p) || 0;
        if (n !== 1) errors.push(`files に ${p} が ${n} 回`);
    }
    if (cs.files.length !== inputPaths.length) errors.push(`files の数 ${cs.files.length} ≠ 変更ファイル数 ${inputPaths.length}`);
    for (const f of cs.files) {
        if (!Array.isArray(f.windows) || f.windows.length === 0) errors.push(`files[${f.path}].windows が空`);
        else for (const id of f.windows) if (!winById.has(id)) errors.push(`files[${f.path}].windows の ${id} が存在しない`);
        if (!groups.some(g => g.kind === f.block)) errors.push(`files[${f.path}].block ${f.block} のブロックが無い`);
    }
    for (const w of windows) {
        if (!w.group || !groupById.has(w.group)) errors.push(`window ${w.id} の group ${w.group} が groups に無い`);
    }
    for (const c of (Array.isArray(canvas.connections) ? canvas.connections : [])) {
        const a = winById.get(c.from);
        const b = winById.get(c.to);
        if (!a || !b) { errors.push(`connection ${c.from}→${c.to} の端が無い`); continue; }
        const g = groupById.get(a.group);
        if (a.group !== b.group || !g || g.kind !== 'island') errors.push(`connection ${c.from}→${c.to} が同じ島の中に無い`);
    }
    const blockKinds = groups.filter(g => g.kind !== 'island').map(g => g.kind);
    const expectedOrder = BLOCK_ORDER.filter(k => blockKinds.includes(k));
    if (JSON.stringify(blockKinds) !== JSON.stringify(expectedOrder)) errors.push(`ブロック順 ${blockKinds.join(',')}`);
    for (const g of groups) {
        if (g.kind === 'island' && (!g.parent || !groupById.has(g.parent) || !ISLAND_PARENT_KINDS.includes(groupById.get(g.parent).kind))) {
            errors.push(`島 ${g.id} の parent が java / clientside ブロックでない`);
        }
    }
    return errors;
}

// ---------------------------------------------------------------------------
// 生成（git の I/O と Java 解析の呼び出し。vscode には依存しない）
// ---------------------------------------------------------------------------

export type GenerateChangeSetOptions = {
    /** リポジトリのトップレベル（getRepoRoot） */
    repoRoot: string;
    /** 対象（コミットかワークベンチ） */
    target: ChangeSetTarget;
    /** Java ブロックの解析（javaCallHierarchy.analyzeChangeSet）。Java ファイルがあるときだけ呼ぶ。例外はフォールバック扱い */
    analyzeJava: (files: JavaChangeSetRequestFile[]) => Promise<JavaChangeSetResult | null>;
    /** clientside の解析（JS/TS 拡張の既存 API）。解析対象があるときだけ呼ぶ。無ければ（例外も）ファイル単位で出す */
    analyzeClientside?: (files: ClientsideRequestFile[]) => Promise<ClientsideChangeSetResult | null>;
};

export type GenerateChangeSetResult = {
    canvas: any;
    javaError?: string;
    clientsideError?: string;
    /** 契約の不変条件の違反（空なら満たしている） */
    errors: string[];
    /** callcanvas_changeset_<名前>.json の <名前> */
    shortName: string;
    fileCount: number;
};

/** 対象の変更ファイルに、表示する内容と作業ツリー一致の判定を足す */
export async function collectChangeSetInputs(repoRoot: string, range: ResolvedChangeSet): Promise<ChangeSetFileInput[]> {
    const changed = await getChangeSetFiles(repoRoot, range);
    const match = await getWorktreeMatchMap(repoRoot, range.head, changed.filter(f => f.status !== 'deleted').map(f => f.filePath));
    const readWorktree = (p: string): string | null => {
        try { return fs.readFileSync(path.join(repoRoot, p), 'utf-8'); } catch { return null; }
    };
    const res: ChangeSetFileInput[] = [];
    for (const f of changed) {
        const worktreeMatches = f.status === 'deleted' ? true : match.get(f.filePath) !== false;
        const input: ChangeSetFileInput = { ...f, worktreeMatches, headContent: null, baseContent: null };
        if (f.status !== 'deleted' && !f.binary) {
            input.headContent = (worktreeMatches || !range.head)
                ? readWorktree(f.filePath)
                : await getFileAtRevision(repoRoot, range.head, f.filePath);
        }
        if (f.status === 'deleted') {
            input.baseContent = f.binary ? null : await getFileAtRevision(repoRoot, range.base, f.filePath);
        } else if (!f.binary && classifyBlock(f.filePath) === 'java' && (f.status === 'modified' || f.status === 'renamed') && hasRemovedLines(f.hunks)) {
            input.baseContent = await getFileAtRevision(repoRoot, range.base, f.oldPath || f.filePath);
        }
        res.push(input);
    }
    return res;
}

/**
 * 解析器のウィンドウの filePath（解析器の --workspace＝Java プロジェクト基準）をリポジトリのトップレベル基準にする関数を作る。
 * 入力のパスと突き合わせてプロジェクトの位置（接頭辞）を求め、合流点など入力に無いファイルにも同じ接頭辞を当てる。
 */
export function makeFilePathNormalizer(repoRoot: string, inputPaths: string[], resultPaths: string[]): (p: string) => string {
    const slash = (p: string) => p.replace(/\\/g, '/');
    const prefixes = new Set<string>(['']);
    for (const q0 of resultPaths) {
        if (!q0 || path.isAbsolute(q0)) continue;
        const q = slash(q0);
        for (const p of inputPaths) {
            if (p.endsWith('/' + q)) prefixes.add(p.substring(0, p.length - q.length));
        }
    }
    const ordered = Array.from(prefixes).sort((a, b) => b.length - a.length);
    return (p0: string) => {
        if (!p0) return p0;
        if (path.isAbsolute(p0)) {
            const rel = slash(path.relative(repoRoot, p0));
            return rel.startsWith('..') ? p0 : rel;
        }
        const p = slash(p0);
        if (inputPaths.includes(p)) return p;
        for (const pre of ordered) {
            if (fs.existsSync(path.join(repoRoot, pre + p))) return pre + p;
        }
        return p;
    };
}

/** 対象（コミット・ワークベンチ・ライブ）から変更集合キャンバスを作る（保存はしない） */
export async function generateChangeSetCanvas(opts: GenerateChangeSetOptions): Promise<GenerateChangeSetResult> {
    const range = await resolveChangeSetTarget(opts.repoRoot, opts.target);
    const files = await collectChangeSetInputs(opts.repoRoot, range);
    const javaReq = buildJavaChangeSetRequest(files);
    let java: JavaChangeSetResult | null = null;
    if (javaReq.length > 0) {
        try {
            java = await opts.analyzeJava(javaReq);
        } catch (e) {
            java = { success: false, error: e instanceof Error ? e.message : String(e) };
        }
    }
    const clientsideReq = buildClientsideRequest(files);
    let clientside: ClientsideChangeSetResult | null = null;
    if (clientsideReq.length > 0 && opts.analyzeClientside) {
        try {
            clientside = await opts.analyzeClientside(clientsideReq);
        } catch {
            clientside = null;
        }
    }
    const inputPaths = files.map(f => f.filePath);
    const windowPaths = (data: any): string[] => (data && Array.isArray(data.windows))
        ? data.windows.map((w: any) => w && w.filePath).filter((p: any) => typeof p === 'string')
        : [];
    const resultPaths = (java && java.success) ? windowPaths(java.data) : [];
    if (clientside) {
        for (const a of Object.values(clientside.analyses || {})) if (a && a.success) resultPaths.push(...windowPaths(a.data));
    }
    const live = opts.target.kind === 'live';
    const { canvas, javaError, clientsideError } = composeChangeSetCanvas({
        kind: opts.target.kind,
        commit: live ? null : range.head,
        base: range.base,
        head: live ? range.head! : undefined,
        files,
        java,
        clientside,
        normalizeFilePath: makeFilePathNormalizer(opts.repoRoot, inputPaths, resultPaths),
    });
    return {
        canvas,
        javaError,
        clientsideError,
        errors: validateChangeSetCanvas(canvas, inputPaths),
        shortName: changeSetShortName(range.head, live ? range.base : undefined),
        fileCount: files.length,
    };
}
