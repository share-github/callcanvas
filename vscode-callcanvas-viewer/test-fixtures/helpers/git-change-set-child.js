/**
 * git-change-set.js から起動される子プロセス。
 *
 * src/gitUtils.ts を TypeScript でその場でトランスパイルして読み込み（out/ の古さに左右されない。
 * 'vscode' は空のスタブ）、一時 git リポジトリで全シナリオを実行して結果を JSON で stdout に出す。
 * 結果には hash や一時ディレクトリのパスを入れない（ゴールデン比較のため）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');

// 利用者の git 設定に左右されないようにする
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = '2026-01-01T00:00:00Z';

function loadGitUtils() {
    const ts = require(path.join(ROOT, 'node_modules/typescript'));
    const file = path.join(ROOT, 'src/gitUtils.ts');
    const js = ts.transpileModule(fs.readFileSync(file, 'utf-8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
        fileName: file,
    }).outputText;
    const m = new Module(file);
    m.filename = file;
    m.paths = Module._nodeModulePaths(path.dirname(file));
    m.require = (id) => (id === 'vscode' ? {} : require(id));
    m._compile(js, file);
    return m.exports;
}

const g = loadGitUtils();

// ---- 一時リポジトリ ----
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'callcanvas-gitcs-')));
process.on('exit', () => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

function git(...args) {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}
function write(rel, content) {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
}
function lines(n, prefix) {
    return Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join('\n') + '\n';
}
const PNG1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]);
const PNG2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 9, 9, 9]);

git('init', '-q', '-b', 'main');

// c1: 初期状態（ルートコミット）
write('src/Foo.java', 'class Foo {\n    int a = 1;\n    int b = 2;\n}\n');
write('src/Gone.java', 'class Gone {\n    void bye() {}\n}\n');
write('src/Old.java', lines(20, '// old'));
write('web/app.js', 'function app() {\n  return 1;\n}\n');
write('assets/logo.png', PNG1);
write('db/schema.sql', 'CREATE TABLE t (id INT);\n');
write('pom.xml', '<project>\n  <version>1</version>\n</project>\n');
write('style.css', 'body { color: red; }\n');
git('add', '-A');
git('commit', '-q', '-m', 'c1');
const c1 = git('rev-parse', 'HEAD');

// c2: 変更・削除・リネーム（内容も少し変更）・追加・バイナリ変更・バイナリ追加
// パス順で Foo.java（変更）の直後に Gone.java（削除）が来る → 旧パーサでは削除の hunk が Foo.java に混入した
write('src/Foo.java', 'class Foo {\n    int a = 10;\n    int b = 2;\n}\n');
fs.rmSync(path.join(repo, 'src/Gone.java'));
fs.rmSync(path.join(repo, 'src/Old.java'));
write('src/New.java', lines(20, '// old').replace('// old line 5\n', '// new line 5\n'));
write('web/new.ts', 'export const x: number = 1;\n');
write('assets/logo.png', PNG2);
write('assets/data.bin', Buffer.from([0, 1, 2, 3]));
write('pom.xml', '<project>\n  <version>2</version>\n</project>\n');
git('add', '-A');
git('commit', '-q', '-m', 'c2');
const c2 = git('rev-parse', 'HEAD');

// c3: JS と SQL を変更
write('web/app.js', 'function app() {\n  return 2;\n}\n');
write('db/schema.sql', 'CREATE TABLE t (id INT);\nCREATE INDEX i ON t (id);\n');
git('add', '-A');
git('commit', '-q', '-m', 'c3');
const c3 = git('rev-parse', 'HEAD');

// 作業ツリー（ワークベンチ）: Foo.java を未コミットで変更（staged と unstaged の両方）、未登録ファイル（ワークベンチに含めない）、無視ファイル
write('src/Foo.java', 'class Foo {\n    int a = 10;\n    int b = 3;\n}\n');
git('add', 'src/Foo.java');
write('src/Foo.java', 'class Foo {\n    int a = 10;\n    int b = 3;\n    int c = 4;\n}\n');
write('web/untracked.html', '<p>hi</p>\n');
write('.gitignore', 'ignored.log\n');
write('ignored.log', 'x\n');
git('add', '.gitignore');

const hashName = { [c1]: 'c1', [c2]: 'c2', [c3]: 'c3', '4b825dc642cb6eb9a060e54bf8d69288fbee4904': 'emptyTree' };
const nameOf = (h) => (h === null ? null : (hashName[h] || `unknown:${h}`));

/** ChangedFile[] を比較用に（そのまま。キー順を固定） */
function files(list) {
    return list.map(f => {
        const o = { filePath: f.filePath, status: f.status };
        if (f.oldPath !== undefined) o.oldPath = f.oldPath;
        o.binary = f.binary;
        o.hunks = f.hunks;
        return o;
    });
}

async function errorOf(fn) {
    try { await fn(); return null; } catch (e) { return String(e.message).replace(/: .*failed.*$/, ''); }
}

const scenarios = {
    async 'resolve-target'() {
        const commit = await g.resolveChangeSetTarget(repo, { kind: 'commit', commit: c2.substring(0, 8) });
        const root = await g.resolveChangeSetTarget(repo, { kind: 'commit', commit: c1 });
        const workbench = await g.resolveChangeSetTarget(repo, { kind: 'workbench' });
        const r = (x) => ({ base: nameOf(x.base), head: nameOf(x.head) });
        return {
            commit: r(commit), rootCommit: r(root), workbench: r(workbench),
            repoRootIsRepo: (await g.getRepoRoot(path.join(repo, 'src'))) === repo,
            invalidDash: await errorOf(() => g.resolveCommit(repo, '--output=x')),
            unknown: await errorOf(() => g.resolveCommit(repo, 'no-such-rev')),
        };
    },
    'parse-target'() {
        const p = (t) => { try { return g.parseChangeSetTarget(t); } catch (e) { return { error: e.message }; } };
        return {
            single: p(' abc123 '),
            workbench: p('workbench'),
            workbenchUpper: p(' WORKBENCH '),
            empty: p(''),
            range: p('v1..v2'),
            baseDots: p('v1..'),
            symmetric: p('a...b'),
        };
    },
    async 'single-commit'() {
        const range = await g.resolveChangeSetTarget(repo, { kind: 'commit', commit: c2 });
        return files(await g.getChangeSetFiles(repo, range));
    },
    async 'root-commit'() {
        const range = await g.resolveChangeSetTarget(repo, { kind: 'commit', commit: c1 });
        return files(await g.getChangeSetFiles(repo, range)).map(f => ({ filePath: f.filePath, status: f.status, binary: f.binary, hunkCount: f.hunks.length }));
    },
    async 'workbench'() {
        // git diff HEAD と同じ: ステージ済み＋未ステージの追跡ファイルだけ（未登録の web/untracked.html・無視ファイルは含めない）
        const range = await g.resolveChangeSetTarget(repo, { kind: 'workbench' });
        const list = files(await g.getChangeSetFiles(repo, range));
        const gitDiffHead = execFileSync('git', ['diff', 'HEAD', '--name-only'], { cwd: repo, encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
        return { files: list, sameAsGitDiffHead: JSON.stringify(list.map(f => f.filePath)) === JSON.stringify(gitDiffHead.sort()) };
    },
    async 'deleted-hunk-not-mixed'() {
        // 既存の「コミット差分表示」と同じコマンドの出力をパースする
        const out = execFileSync('git', ['show', '-m', c2, '--unified=0', '--no-color'], { cwd: repo, encoding: 'utf-8' });
        return g.parseGitDiffDetailed(out).map(d => ({
            filePath: d.filePath, oldPath: d.oldPath, binary: d.binary,
            removed: d.hunks.reduce((n, h) => n + h.lines.filter(l => l.type === 'remove').length, 0),
            added: d.hunks.reduce((n, h) => n + h.lines.filter(l => l.type === 'add').length, 0),
        }));
    },
    async 'file-content'() {
        const r2 = await g.resolveChangeSetTarget(repo, { kind: 'commit', commit: c2 });
        const rWt = await g.resolveChangeSetTarget(repo, { kind: 'workbench' });
        return {
            baseOfDeleted: await g.getBaseContent(repo, r2, 'src/Gone.java'),
            headOfDeleted: await g.getHeadContent(repo, r2, 'src/Gone.java'),
            headOfFooAtC2: await g.getHeadContent(repo, r2, 'src/Foo.java'),
            headOfFooWorktree: await g.getHeadContent(repo, rWt, 'src/Foo.java'),
            baseOfRenamedOld: (await g.getBaseContent(repo, r2, 'src/Old.java')).split('\n').length,
            missingInWorktree: await g.getHeadContent(repo, rWt, 'src/Gone.java'),
            binaryLength: (await g.getFileAtRevision(repo, c2, 'assets/data.bin')).length,
        };
    },
    async 'worktree-match'() {
        const paths = ['src/Foo.java', 'web/app.js', 'src/New.java', 'src/Gone.java', 'web/untracked.html', 'assets/logo.png'];
        const atC3 = await g.getWorktreeMatchMap(repo, c3, paths);
        const atC2 = await g.getWorktreeMatchMap(repo, c2, paths);
        const atNull = await g.getWorktreeMatchMap(repo, null, paths);
        return {
            headC3: Object.fromEntries(atC3),
            headC2: Object.fromEntries(atC2),
            headNull: Object.fromEntries(atNull),
            singleMismatch: await g.isHeadContentSameAsWorktree(repo, c3, 'src/Foo.java'),
            singleMatch: await g.isHeadContentSameAsWorktree(repo, c3, 'db/schema.sql'),
            singleNull: await g.isHeadContentSameAsWorktree(repo, null, 'src/Foo.java'),
        };
    },
    'parse-special-paths'() {
        // 空白・クォートの要るパス・バイナリ・モードだけの変更（hunk も ---/+++ も無い）
        const out = [
            'diff --git a/docs/my file.bin b/docs/my file.bin',
            'index 1111111..2222222 100644',
            'Binary files a/docs/my file.bin and b/docs/my file.bin differ',
            'diff --git "a/q\\"uote \\303\\274.txt" "b/q\\"uote \\303\\274.txt"',
            'index 1111111..2222222 100644',
            '--- "a/q\\"uote \\303\\274.txt"',
            '+++ "b/q\\"uote \\303\\274.txt"',
            '@@ -1 +1 @@',
            '-a',
            '+b',
            'diff --git a/run.sh b/run.sh',
            'old mode 100644',
            'new mode 100755',
            'diff --git a/x y.txt b/z w.txt',
            'similarity index 100%',
            'rename from x y.txt',
            'rename to z w.txt',
            '',
        ].join('\n');
        return g.parseGitDiffDetailed(out);
    },
    'classify-block'() {
        const paths = [
            'src/main/java/a/Foo.java', 'A.JAVA',
            'web/index.html', 'web/x.htm', 'web/f.xhtml', 'WEB-INF/a.jsp', 'WEB-INF/b.jspf', 'WEB-INF/c.jspx', 'WEB-INF/t.tag',
            'tpl/a.ftl', 'tpl/b.ftlh', 'view/page.mayaa', 'tpl/c.vm', 'templates/order.th.html', 'x.thymeleaf',
            'a.js', 'b.jsx', 'c.mjs', 'd.cjs', 'e.ts', 'f.tsx', 'g.d.ts', 'h.mts', 'i.vue',
            'pom.xml', 'mapper/OrderMapper.XML',
            'db/V1__init.sql', 'q.SQL',
            'style.css', 'a.scss', 'README.md', 'Makefile', '.gitignore', 'logo.png', 'app.properties', 'b.yml', 'data.json', 'x.xsd', 'noext', 'dir.java/file', '',
        ];
        const each = Object.fromEntries(paths.map(p => [p, g.classifyBlock(p)]));
        const grouped = g.classifyFiles(paths.map(filePath => ({ filePath })));
        const counts = Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, v.length]));
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        return { each, counts, inputCount: paths.length, total, order: g.BLOCK_ORDER };
    },
    async 'classify-change-set'() {
        // 実際の変更集合（コミット c2）で漏れが無いこと
        const range = await g.resolveChangeSetTarget(repo, { kind: 'commit', commit: c2 });
        const list = await g.getChangeSetFiles(repo, range);
        const grouped = g.classifyFiles(list);
        const byBlock = Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, v.map(f => f.filePath)]));
        const total = Object.values(grouped).reduce((a, v) => a + v.length, 0);
        return { inputCount: list.length, total, byBlock };
    },
};

(async () => {
    const out = {};
    for (const [name, fn] of Object.entries(scenarios)) {
        try { out[name] = await fn(); } catch (e) { out[name] = { __error: e.stack || String(e) }; }
    }
    process.stdout.write(JSON.stringify(out));
})();
