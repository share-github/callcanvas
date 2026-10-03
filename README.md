# CallCanvas

Java / JavaScript / TypeScript のメソッド呼び出し階層を静的解析し、キャンバス上にウィンドウとして並べて表示する VS Code 拡張機能セット。

## 同梱物

| パス | 内容 |
|---|---|
| `release/*.vsix` | ビルド済み拡張 4 個（下表）。バージョンはファイル名に含まない |
| `.vscode/settings.json` | 推奨設定の例（解析深さ・Java 言語レベル・Viewer 表示など） |
| `app/` | Java 解析器のソース（ビルド済み JAR は `vscode-java-call-hierarchy/resources/` に同梱） |
| `vscode-*/` | 各拡張のソース |
| `callcanvas-nvim/` | VS Code を使わず **Neovim + ブラウザ**で同じ Viewer を動かすホスト（下記「Neovim から使う」） |

| VSIX | 拡張 ID | 役割 |
|---|---|---|
| `release/callcanvas-viewer.vsix` | `share-github.callcanvas-viewer` | 解析結果（CallCanvas JSON）を表示する Viewer。**必須** |
| `release/java-call-hierarchy.vsix` | `share-github.java-call-hierarchy` | Java の呼び出し解析 |
| `release/javascript-call-hierarchy.vsix` | `share-github.javascript-call-hierarchy` | JavaScript / HTML・JSP 内スクリプトの呼び出し解析 |
| `release/typescript-call-hierarchy.vsix` | `share-github.typescript-call-hierarchy` | TypeScript / TSX の呼び出し解析 |

Viewer と、対象言語の解析拡張を入れる。全部入れても問題ない。

## 前提

- VS Code 1.85 以上（Cursor / Windsurf など VS Code 互換エディタも可。CLI 名を `code` から `cursor` / `windsurf` に置き換える）
- Java 解析を使う場合: **Java 21 以上**の実行環境（`java` が PATH にあるか、`javaCallHierarchy.javaPath` で指定）。解析対象プロジェクトの Java バージョンとは別

## VSIX のインストール

このリポジトリのルートで実行する。

```bash
code --install-extension release/callcanvas-viewer.vsix --force \
  && code --install-extension release/java-call-hierarchy.vsix --force \
  && code --install-extension release/javascript-call-hierarchy.vsix --force \
  && code --install-extension release/typescript-call-hierarchy.vsix --force
```

- `--force` を付けると、インストール済みでも上書き更新される（初回でも付けてよい）
- インストール後、エディタのウィンドウを再読み込みする（コマンドパレット → `Developer: Reload Window`）

確認:

```bash
code --list-extensions --show-versions | grep -E "callcanvas-viewer|java-call-hierarchy|javascript-call-hierarchy|typescript-call-hierarchy"
```

devcontainer で使う場合は、`devcontainer.json` の `customizations.vscode.extensions` に VSIX のパス（例: `${containerWorkspaceFolder}/<このリポジトリの配置先>/release/callcanvas-viewer.vsix`）を列挙する。

アンインストール:

```bash
code --uninstall-extension share-github.callcanvas-viewer \
  && code --uninstall-extension share-github.java-call-hierarchy \
  && code --uninstall-extension share-github.javascript-call-hierarchy \
  && code --uninstall-extension share-github.typescript-call-hierarchy
```

## .vscode/settings.json の導入

`.vscode/settings.json` は**解析したいプロジェクト**に適用する設定の例。このリポジトリ自身のためのものではない。

- 解析対象プロジェクトに `.vscode/settings.json` が**無い**場合: そのままコピーする
  ```bash
  mkdir -p <対象プロジェクト>/.vscode
  cp .vscode/settings.json <対象プロジェクト>/.vscode/settings.json
  ```
- **既にある**場合: 上書きせず、下のキーを既存の JSON オブジェクトにマージする（既存キーと重複したら、どちらを残すか利用者に確認する）
- 全プロジェクト共通にしたい場合は、ユーザー設定（コマンドパレット → `Preferences: Open User Settings (JSON)`）に同じキーを追記する

設定は保存すると即反映される（再起動不要）。

### 設定キー

同梱の `.vscode/settings.json` に含まれるキーと、変えることが多い値:

| キー | 同梱値 | 既定値 | 説明 |
|---|---|---|---|
| `javaCallHierarchy.depth` | `10` | `5` | Java 解析の最大深さ |
| `javaCallHierarchy.languageLevel` | `"JAVA_21"` | `"JAVA_21"` | 解析対象プロジェクトの Java 言語レベル。`JAVA_8` / `JAVA_11` / `JAVA_17` / `JAVA_21` / `JAVA_22` / `JAVA_23` / `JAVA_24` / `JAVA_25` から、**対象プロジェクトに合わせて**選ぶ |
| `javaCallHierarchy.debug` | `false` | `false` | 詳細なエラー出力 |
| `javaCallHierarchy.quiet` | `false` | `false` | ログを抑制し性能サマリのみ出力 |
| `javaCallHierarchy.timing` | `false` | `false` | ブロック単位の処理時間を出力 |
| `jsCallHierarchy.depth` | `20` | `5` | JavaScript 解析の最大深さ |
| `tsCallHierarchy.depth` | `10` | `5` | TypeScript 解析の最大深さ |
| `callcanvas.windowWidth` | `600` | `600` | Viewer のウィンドウ幅（px） |
| `callcanvas.jumpToCallTargetKey` | `"shift+b"` | `"f12"` | Viewer 内で呼び出し先へジャンプするキー |
| `callcanvas.debug` | `false` | `false` | Viewer のデバッグ出力 |
| `callcanvas.performanceLog` | `false` | `false` | Viewer の性能ログ（処理時間のみ） |

同梱ファイルに無いが使える主な設定:

| キー | 既定値 | 説明 |
|---|---|---|
| `javaCallHierarchy.javaPath` | `""` | 解析器を実行する Java のパス（空なら PATH の `java`） |
| `javaCallHierarchy.excludePatterns` | `"**generated**,**config**,**dto**"` | 解析から除外するパターン（カンマ区切り） |
| `callcanvas.minWindowHeight` / `callcanvas.maxWindowHeight` | `80` / `600` | Viewer ウィンドウの高さの下限 / 上限（px） |
| `tsCallHierarchy.nestedLocalWindows` | `true` | 名前付きのローカル関数を別ウィンドウに分割する |
| `callcanvas.jumpBackKey` | `"shift+o"` | **Neovim + ブラウザ利用時のみ**。ジャンプ履歴を戻るキー（VS Code 側は `alt+←`） |
| `callcanvas.interceptBrowserBack` | `true` | **同上**。`alt+←` / `⌘←` をブラウザの「戻る」ではなくジャンプ履歴に割り当てる |

## 使い方

1. 解析したいメソッド / 関数の宣言行にカーソルを置く
2. 右クリック → **`CallCanvas: Open Viewer with File`**（またはコマンドパレットから同名コマンド）
3. 呼び出し階層が CallCanvas JSON（`callcanvas_<名前>.json`）に出力され、Viewer で開く
4. Viewer 上で **`CallCanvas: Analyze Next Level`** を実行すると、さらに深い階層を追加解析する

Java ではクラス宣言行にカーソルを置くとクラス単位で解析する（初回はインデックス構築の完了を待つ）。

### 変更集合キャンバス（コミット / ワークベンチの変更を 1 枚に）

コマンドパレット → **`CallCanvas: Open Change Set`** で「📝 コミット」か「📄 ワークベンチ（未コミットの変更）」を選ぶと、
その変更を 1 枚のキャンバスに描く。

- 変更ファイルは拡張子で java / clientside（HTML 系テンプレートと JS・TS）/ xml / sql / other の枠に分かれる。枠どうしは結ばない
- Java は変更メソッドを呼び出し関係でまとめ、間にある未変更のメソッドは「経由」、共通の呼び出し元は「合流点」として描く
  （Java の呼び出しインデックスを使う）
- clientside は JS / TS 拡張の解析で変更関数をまとめ、テンプレートは include でつなぐ
- それ以外の変更（メソッド外の変更・削除・XML・SQL など）はファイル単位のウィンドウで出す

## Neovim から使う（VS Code 不要）

`callcanvas-nvim/` は、VS Code の代わりに **Neovim + ブラウザ**で同じ Viewer を使うためのホスト。
カーソル位置でコマンドを実行すると、ローカル HTTP サーバが立ち上がり、ブラウザで
キャンバスを操作できる。ブラウザからソースへジャンプすると Neovim 側が該当行を開く。

解析・シグネチャ解決・Viewer の HTML は**拡張のコンパイル済みコードをそのまま動かしている**
ため、VS Code 版と同じ結果になる（Viewer の JS は無改変）。

### 前提

- Neovim 0.10 以上、Node.js 18 以上
- Java 解析を使う場合: Java 21 以上
- **拡張がビルド済みであること**（`out/` はリポジトリに含まれないため、下記のいずれか）

```bash
# a) このリポジトリでビルドする
for d in vscode-java-call-hierarchy vscode-javascript-call-hierarchy \
         vscode-typescript-call-hierarchy vscode-callcanvas-viewer; do
  (cd "$d" && npm install && npm run compile)
done

# b) すでに VSIX をインストール済みなら何もしなくてよい
#    (~/.vscode/extensions/share-github.* を自動検出する)
```

### セットアップ（lazy.nvim / LazyVim）

`callcanvas-nvim/lazyvim/callcanvas.lua` が spec の雛形。`~/.config/nvim/lua/plugins/` に
コピー（または symlink）し、`dir` をこのリポジトリの `callcanvas-nvim` に合わせる。

```lua
{
  dir = '/path/to/callcanvas/callcanvas-nvim',
  main = 'callcanvas',           -- lua モジュール名（ディレクトリ名と異なる）
  cmd = { 'CallCanvas', 'CallCanvasBrowse', 'CallCanvasUrl',
          'CallCanvasList', 'CallCanvasStatus', 'CallCanvasStop', 'CallCanvasChangeSet',
          'CallCanvasInstallHook', 'CallCanvasInstallSkill' },
  keys = { { '<leader>vv', '<cmd>CallCanvas<cr>', desc = 'CallCanvas' } },
  opts = {
    -- Neovim がコンテナ / リモートで、ブラウザが手元にある場合:
    -- host = '0.0.0.0', port = 7333,   （そのポートを publish / forward しておく）
    jump_mode = 'split',                -- ジャンプ先: 'split'（専用窓1枚を再利用）| 'here' | 'tab'
    jump_focus = 'auto',                -- 'auto': Neovim を見ている時だけフォーカスが追従する
  },
}
```

> LazyVim は `<leader>c*`（`<leader>cc` = Run Codelens など）をほぼ使用済みのため、
> 雛形では未使用の `<leader>v*` を使っている。

### 使い方

| コマンド / キー | 動作 |
|---|---|
| `:CallCanvas`（`<leader>vv`） | カーソル位置のメソッド / 関数を解析し、URL をクリップボードへ入れる |
| `:CallCanvasChangeSet [<hash>\|workbench\|live]`（`<leader>vc`） | 変更集合キャンバス。引数なしならライブ / ワークベンチ / 直近のコミットの一覧から選ぶ。`live` は AI の作業を追う（下記） |
| `:CallCanvasInstallHook[!]` | ライブ変更集合に必要な Claude Code の hook を足す（`!` で外す。下記） |
| `:CallCanvasList`（`<leader>vl`） | 開いているキャンバスの一覧 |
| `:CallCanvasUrl`（`<leader>vu`） | URL の再表示・再コピー |
| `:CallCanvasInstallSkill` | Claude Code にキャンバスへコメントを書かせる skill を書き出す（下記） |
| `:CallCanvasStatus` / `:CallCanvasStop` | ホストの状態表示 / 終了 |

1. 解析したいメソッド / 関数の行にカーソルを置いて `:CallCanvas`
2. URL は **OSC 52 でターミナルのクリップボードに直接入る**ので、ブラウザに貼って開く
   （ターミナル側でクリップボード書き込みの許可が必要。tmux は `set -g set-clipboard on`）
3. 一度開いたら `http://127.0.0.1:<port>/` をブックマークしておけばよい。以降 `:CallCanvas`
   を実行するとそのタブが自動で更新される
4. キャンバスは同時に何枚でも開ける。`:CallCanvas` がクリップボードに入れる URL は
   「今解析したキャンバス」を指すので、**新しいタブに貼れば並べて比較できる**
   （ページ右下の `canvases ▾` からも切り替えられる）

Claude Code にコード解説をキャンバスへ書かせる:

1. nvim で `:CallCanvasInstallSkill` を 1 回実行する（`~/.claude/skills/callcanvas-comment/SKILL.md` に、
   この環境の CLI のパスを埋めた skill を書き出す。sh を使わないので macOS / Windows / コンテナで同じ。
   特定のリポジトリだけなら `:CallCanvasInstallSkill .claude/skills`）
2. 任意のリポジトリの Claude Code に「callcanvas のキャンバスに〜を解説して」と頼む。AI は
   `callcanvas canvases`（キャンバスと各ウィンドウのファイル・行範囲）を見て、`callcanvas comment
   --file <path> --line N --text ...` でファイル + 行番号を指定して書く（変更集合の追加・削除行も可）
3. ブラウザをリロードするとコメントが出る（AI が書く前から開いていたタブは、編集する前にリロードする）

AI（Claude Code）の作業をライブで追う（ライブ変更集合）:

**Claude Code の hook が必要**（無いと作業ツリーの変化がホストに伝わらず、キャンバスは更新されない。
その場合はブラウザのバッジと nvim の通知に「hook が未設定」と出る）。

1. nvim で `:CallCanvasInstallHook` を 1 回実行する。`~/.claude/settings.json`（`$CLAUDE_CONFIG_DIR` があればその下）に、
   ツール呼び出しのたび（`PostToolUse`。全ツール）とターンの終わり（`Stop`）に `callcanvas notify` を呼ぶ hook を足す
   （既存の設定と hook は残す。何度実行しても重複しない。`:CallCanvasInstallHook!` で外す）。
   特定のリポジトリだけにするなら CLI で `node <このリポジトリ>/callcanvas-nvim/src/cli.js install-hook --settings <リポジトリ>/.claude/settings.local.json`。
   入れたあと、起動中の Claude Code は起動し直す
2. AI に作業させる前に `:CallCanvasChangeSet live`（一覧の先頭「ライブ」でも可）。今の作業ツリーを起点にした空のキャンバスが開く
3. 同じマシンの同じリポジトリで Claude Code に作業させる。作業ツリーが変わるたびにホストが裏で作り直し、
   ブラウザ右下のバッジに `更新あり（N ファイル / M 島） 取り込む` が出る。**押したときだけ**表示が新しくなる（読んでいる最中に変わらない）
4. AI の 1 回目の作業をコミット / ワークベンチの変更集合で見たあとに追い始めるなら、そのキャンバスのバッジの
   「● ライブ追従を開始」（その変更集合の起点のまま、これからの変更を足していく）

- 起点は動かない。AI が途中でコミットしても、それまでの変更はキャンバスに残る
- 未追跡の新しいファイルも載る（.gitignore に当たるものと CallCanvas 自身の出力は載らない）
- `callcanvas notify` は作り直しを待たず、何も出力せず、常に終了コード 0（ホストが動いていなければ何もしない）。
  AI 側はこの hook を意識しない（会話には何も入らない）
- hook のコマンドはこのリポジトリの `callcanvas-nvim/src/cli.js` を絶対パスで呼ぶ。Claude Code と nvim は同じマシン（同じコンテナ）で動かす

ブラウザ側のキー操作:

| キー | 動作 |
|---|---|
| タイトルバーをダブルクリック | **右サイドパネルにファイル全文を表示**（該当行をハイライト・自動スクロール、行番号とシンタックスハイライト付き）。既定では Neovim には何もしない。パネルは左端ドラッグで幅変更、`Esc` で閉じる。パネル内の行をダブルクリックすると Neovim がその行へ移動する |
| `callcanvas.jumpToCallTargetKey`（例 `shift+b`） | 呼び出し先へジャンプ。既定の `f12` はブラウザが DevTools に使うため変更推奨 |
| `→` / `←` | ステップ実行。クリックした行から処理順（デバッガの step into と同じく呼び出し先へ入り、終われば呼び出し行に戻る）に 1 つ進む / 戻る。VS Code の Viewer でも同じ |
| `shift+o` / `alt+←` | ジャンプ履歴を戻る（VS Code 版の `alt+←` はブラウザの「戻る」と衝突するため、`shift+o` を既定にしている） |
| `shift+w` | 手前にあるものを閉じる（ファイルパネル → 選択中のウィンドウ）。`ctrl+w` はブラウザがタブを閉じてしまい、拡張側から抑止できないため別のキーにしている |

### 設定

**VS Code と同じ `.vscode/settings.json` を読む**（解析対象プロジェクトのもの、なければ
上位ディレクトリをリポジトリルートまで遡る。コメント付き JSON 可）。上の「設定キー」の表が
そのまま効くので、VS Code 版と設定を共用できる。

ブラウザ専用の設定は VS Code が知らないキーなので、`<プロジェクト>/.callcanvas/config.json`
に置く:

```json
{
  "callcanvas": {
    "nvimJump": false,
    "jumpBackKey": "shift+o",
    "closeKey": "shift+w",
    "interceptBrowserBack": true
  }
}
```

| キー | 既定 | 意味 |
|---|---|---|
| `callcanvas.nvimJump` | `false` | ブラウザから Neovim を動かす（ダブルクリックでエディタを開く）。既定オフ＝ブラウザ側で完結 |
| `callcanvas.jumpBackKey` | `"shift+o"` | ジャンプ履歴を戻るキー |
| `callcanvas.closeKey` | `"shift+w"` | ファイルパネル / 選択中ウィンドウを閉じるキー |
| `callcanvas.interceptBrowserBack` | `true` | `alt+←` / `⌘←` をブラウザの「戻る」ではなくジャンプ履歴に割り当てる |

### ブラウザから Neovim を動かす（既定オフ）

既定では**ブラウザ側で完結する**。タイトルバーをダブルクリックするとブラウザ内の
パネルにファイル全文が出るだけで、Neovim には何も起きない。Neovim も動かしたい場合は
`<プロジェクト>/.callcanvas/config.json` に `{"callcanvas": {"nvimJump": true}}` を置く。

有効にした場合も、ジャンプはブラウザを操作している最中に飛んでくるため、Neovim 側の
作業位置は壊さないようにしている。

- 開く先は専用ウィンドウ 1 枚。初回のジャンプで分割し、以降は同じウィンドウを再利用する
  （ジャンプのたびに分割が増えることはない）
- ファイルツリーやピッカーなどプラグインの UI ウィンドウには開かない（そこへ開くと
  バッファが別のウィンドウへ移され、編集中のファイルが置き換わってしまうため）
- ジャンプ後はカーソルを元のウィンドウに戻すので、Neovim に戻ったとき作業していた場所は
  そのまま残っている
- Neovim にフォーカスがある間は、開いた先にフォーカスが移る（`jump_focus = 'auto'`）

`jump_mode` は `'split'` / `'here'`（カレントウィンドウを置き換え）/ `'tab'`、
`jump_focus` は `'auto'` / `true`（常に追従）/ `false`（常に戻す）から選べる。

### 動作の要点

- サーバは既定で `127.0.0.1` のみ待ち受け、全エンドポイントにセッショントークンが必要。
  静的配信は拡張のディレクトリ配下に限定
- ブラウザを全部閉じてから既定 300 秒（`idle_timeout`）で自動終了する。常駐しない
- 解析対象はディスク上のファイル。未保存バッファは反映されない
- ファイルパネルが読むソースはプロジェクトルート配下に限定される（外は 404）

## AI エージェント向けの導入手順まとめ

1. ユーザーに、どのエディタの CLI（`code` / `cursor` / `windsurf`）を使うかと、解析対象プロジェクトのパスを確認する
2. 「VSIX のインストール」のコマンドを、このリポジトリのルートで実行する
3. `--list-extensions` で 4 拡張（または必要な分）が入ったことを確認する
4. Java を解析する場合は `java -version` が 21 以上か確認する。足りなければユーザーに伝え、`javaCallHierarchy.javaPath` の設定を提案する
5. 「.vscode/settings.json の導入」に従って、対象プロジェクトに設定を入れる。既存の設定ファイルは上書きしない。`javaCallHierarchy.languageLevel` は対象プロジェクトの Java バージョン（`pom.xml` / `build.gradle` など）に合わせる
6. ユーザーにウィンドウの再読み込みを依頼する
7. Neovim で AI の作業をライブで追う（ライブ変更集合）なら Claude Code の hook が必要。`~/.claude/settings.json` を書き換えるので、
   ユーザーの了承を得てから `node <このリポジトリ>/callcanvas-nvim/src/cli.js install-hook`（nvim では `:CallCanvasInstallHook`）を実行し、
   起動中の Claude Code の再起動を依頼する（特定のリポジトリだけなら `--settings <リポジトリ>/.claude/settings.local.json`）
