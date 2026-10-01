/**
 * git-change-set スイート用ヘルパー（変更集合キャンバスの git 層 = src/gitUtils.ts）。
 *
 * gitUtils の関数は git を非同期に呼ぶので、子プロセス（git-change-set-child.js）で
 * 一時リポジトリを作って全シナリオを 1 回だけ実行し、結果を JSON で受け取ってキャッシュする。
 * テストランナーは同期なので spawnSync で待つ。
 */
const path = require('path');
const { spawnSync } = require('child_process');

let _results = null;

function loadResults() {
    if (_results) return _results;
    const child = path.join(__dirname, 'git-change-set-child.js');
    const r = spawnSync(process.execPath, [child], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) {
        throw new Error(`git-change-set child failed (${r.status}): ${r.stderr || r.stdout}`);
    }
    _results = JSON.parse(r.stdout);
    return _results;
}

/** cases.json の input.scenario に対応する結果を返す */
function runScenario(input) {
    const results = loadResults();
    if (!(input.scenario in results)) throw new Error(`unknown scenario: ${input.scenario}`);
    const v = results[input.scenario];
    if (v && v.__error) throw new Error(v.__error);
    return v;
}

module.exports = { runScenario };
