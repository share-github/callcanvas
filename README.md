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
          'CallCanvasList', 'CallCanvasStatus', 'CallCanvasStop' },
  keys = { { '<leader>vv', '<cmd>CallCanvas<cr>', desc = 'CallCanvas' } },
  opts = {
    -- Neovim がコンテナ / リモートで、ブラウザが手元にある場合:
    -- host = '0.0.0.0', port = 7333,   （そのポートを publish / forward しておく）
    jump_mode = 'split',                -- ブラウザからのジャンプ先: 'split' | 'here' | 'tab'
  },
}
```

> LazyVim は `<leader>c*`（`<leader>cc` = Run Codelens など）をほぼ使用済みのため、
> 雛形では未使用の `<leader>v*` を使っている。

### 使い方

| コマンド / キー | 動作 |
|---|---|
| `:CallCanvas`（`<leader>vv`） | カーソル位置のメソッド / 関数を解析し、URL をクリップボードへ入れる |
| `:CallCanvasList`（`<leader>vl`） | 開いているキャンバスの一覧 |
| `:CallCanvasUrl`（`<leader>vu`） | URL の再表示・再コピー |
| `:CallCanvasStatus` / `:CallCanvasStop` | ホストの状態表示 / 終了 |

1. 解析したいメソッド / 関数の行にカーソルを置いて `:CallCanvas`
2. URL は **OSC 52 でターミナルのクリップボードに直接入る**ので、ブラウザに貼って開く
   （ターミナル側でクリップボード書き込みの許可が必要。tmux は `set -g set-clipboard on`）
3. 一度開いたら `http://127.0.0.1:<port>/` をブックマークしておけばよい。以降 `:CallCanvas`
   を実行するとそのタブが自動で更新される
4. キャンバスは同時に何枚でも開ける。`:CallCanvas` がクリップボードに入れる URL は
   「今解析したキャンバス」を指すので、**新しいタブに貼れば並べて比較できる**
   （ページ右下の `canvases ▾` からも切り替えられる）

ブラウザ側のキー操作:

| キー | 動作 |
|---|---|
| タイトルバーをダブルクリック | **右サイドパネルにファイル全文を表示**（該当行をハイライト・自動スクロール）し、Neovim 側でも該当行を開く。パネルは左端ドラッグで幅変更、`Esc` で閉じる。パネル内の行をダブルクリックすると Neovim がその行へ移動する |
| `callcanvas.jumpToCallTargetKey`（例 `shift+b`） | 呼び出し先へジャンプ。既定の `f12` はブラウザが DevTools に使うため変更推奨 |
| `shift+o` / `alt+←` | ジャンプ履歴を戻る（VS Code 版の `alt+←` はブラウザの「戻る」と衝突するため、`shift+o` を既定にしている） |

### 設定

**VS Code と同じ `.vscode/settings.json` を読む**（解析対象プロジェクトのもの、なければ
上位ディレクトリをリポジトリルートまで遡る。コメント付き JSON 可）。上の「設定キー」の表が
そのまま効くので、VS Code 版と設定を共用できる。

ブラウザ専用の設定は VS Code が知らないキーなので、`<プロジェクト>/.callcanvas/config.json`
に置く:

```json
{
  "callcanvas": {
    "openFileMode": "both",
    "jumpBackKey": "shift+o",
    "interceptBrowserBack": true
  }
}
```

| キー | 既定 | 意味 |
|---|---|---|
| `callcanvas.openFileMode` | `"both"` | タイトルバーのダブルクリック時の動作。`both` = ファイルパネル＋Neovim ジャンプ、`panel` = パネルのみ、`nvim` = ジャンプのみ |
| `callcanvas.jumpBackKey` | `"shift+o"` | ジャンプ履歴を戻るキー |
| `callcanvas.interceptBrowserBack` | `true` | `alt+←` / `⌘←` をブラウザの「戻る」ではなくジャンプ履歴に割り当てる |

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
