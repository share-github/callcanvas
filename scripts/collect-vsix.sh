#!/usr/bin/env bash
#
# collect-vsix.sh — 各拡張の最新 VSIX を release/ に安定ファイル名で集約する。
#
# 配布モデル (B):
#   配布の正は release/<name>.vsix（安定名・Git 追跡対象）。
#   各拡張ディレクトリの <name>-<version>.vsix は vsce package のビルド成果物（.gitignore 済み）で、
#   このスクリプトが release/ へ集約したら **per-dir 側は掃除する（move 相当）**。
#   → 各拡張ディレクトリに VSIX が残らず、常に release/ だけが最新の配布物になる。
#
# 堅牢性の原則:
#   - 各拡張は独立処理。1 拡張の失敗（package.json 欠如・コピー失敗等）で全体を中断しない（continue）。
#   - per-dir の掃除は「regular file への cp が検証成功したとき」だけ行う（失敗時は source を残す）。
#
# 使い方:
#   scripts/collect-vsix.sh          # 全拡張を集約（各拡張の vsce package 後に実行）
#
set -uo pipefail   # 注: set -e は使わない（per-item 失敗で全体中断させないため。失敗は各所で明示処理）

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REL="$ROOT/release"

if ! mkdir -p "$REL" 2>/dev/null; then
  echo "[fatal] release ディレクトリを作成できません: $REL" >&2
  exit 1
fi

# 前回の異常終了（mktemp と mv の間で kill 等）で残った一時ファイルを掃除
find "$REL" -maxdepth 1 -type f -name '.*.vsix.*' -delete 2>/dev/null || true

# 対象拡張ディレクトリ（package.json の name をそのまま安定ファイル名に使う）
EXT_DIRS=(
  vscode-java-call-hierarchy
  vscode-javascript-call-hierarchy
  vscode-typescript-call-hierarchy
  vscode-callcanvas-viewer
)

# package.json のフィールドを安全に取得（見つからなければ空文字。決して非ゼロ終了で呼び出し側を壊さない）
json_field() { # $1=package.json path  $2=field
  local f="$1" key="$2" val=""
  [ -f "$f" ] || { printf '%s' ""; return 0; }
  val="$(node -p "require('$f').$key" 2>/dev/null)" || val=""
  if [ -z "$val" ] || [ "$val" = "undefined" ]; then
    # grep フォールバック: キー単位で "key" : "value" を抽出（圧縮1行/整形どちらでも正しく取る。
    # 旧実装は greedy な sed で1行圧縮形式だと隣キーの値を拾う不具合があった）
    val="$(grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$f" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')" || val=""
  fi
  printf '%s' "$val"
  return 0
}

manifest_rows=""     # VERSIONS.md の行を貯めて最後にまとめて書く（途中中断で壊れないように）
collected=0
already=0
missing=0
failed=0

for d in "${EXT_DIRS[@]}"; do
  dir="$ROOT/$d"
  if [ ! -d "$dir" ]; then
    echo "[skip] $d （ディレクトリなし）"
    continue
  fi

  pj="$dir/package.json"
  if [ ! -f "$pj" ]; then
    echo "[warn] $d: package.json が無く name/version を解決できません（スキップ）"
    manifest_rows+="| $d | (package.json なし) | - |"$'\n'
    failed=$((failed + 1))
    continue
  fi

  name="$(json_field "$pj" name)"
  ver="$(json_field "$pj" version)"
  # name はファイル名として使い rm -rf の対象にもなるため、パス区切り/トラバーサルを拒否
  case "$name" in
    ""|*/*|*\\*|*..*)
      echo "[warn] $d: name が空または不正 ('$name')。安全のためスキップ"
      manifest_rows+="| $d | ${ver:-?} | - |"$'\n'
      failed=$((failed + 1))
      continue
      ;;
  esac
  dest="$REL/${name}.vsix"

  # バージョン一致の VSIX を優先。無ければ mtime 最新にフォールバック。
  src="$dir/${name}-${ver}.vsix"
  if [ ! -f "$src" ]; then
    src="$(ls -t "$dir"/*.vsix 2>/dev/null | head -1)"
  fi

  if [ -z "${src:-}" ] || [ ! -f "$src" ]; then
    # per-dir に VSIX が無い。既に集約済みなら OK、そうでなければ未パッケージ。
    if [ -f "$dest" ]; then
      echo "[keep] $name: per-dir に VSIX なし。release/${name}.vsix は集約済み（維持）"
      manifest_rows+="| $name | $ver | ${name}.vsix |"$'\n'
      already=$((already + 1))
    else
      echo "[warn] $name: VSIX が見つかりません（vsce package 未実行の可能性）"
      manifest_rows+="| $name | (なし) | - |"$'\n'
      missing=$((missing + 1))
    fi
    continue
  fi

  # アトミック配置: 一時ファイルへコピー→検証→mv で差し替える。
  # これにより 0byte/破損 source が既存の正 (release/<name>.vsix) を破壊しない
  # （cp を live canonical へ直接書くと、事後検証より前に潰れてしまうため）。
  tmp="$(mktemp "$REL/.${name}.vsix.XXXXXX" 2>/dev/null)"
  if [ -z "${tmp:-}" ] || [ ! -f "$tmp" ]; then
    echo "[error] $name: 一時ファイルを作成できません。既存の release/${name}.vsix は保全"
    manifest_rows+="| $name | $ver (一時作成失敗) | - |"$'\n'
    failed=$((failed + 1))
    continue
  fi
  if ! cp -f "$src" "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    echo "[error] $name: コピーに失敗。既存の release/${name}.vsix と per-dir を保全"
    manifest_rows+="| $name | $ver (コピー失敗) | - |"$'\n'
    failed=$((failed + 1))
    continue
  fi
  # source が空/破損なら、既存の正を一切壊さず中断（temp を捨てるだけ）
  if [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    echo "[error] $name: source が空/不正。既存の release/${name}.vsix と per-dir を保全"
    manifest_rows+="| $name | $ver (source 不正) | - |"$'\n'
    failed=$((failed + 1))
    continue
  fi
  # dest が通常ファイルでない（ディレクトリ等の破損状態）なら除去してから差し替え
  if [ -e "$dest" ] && [ ! -f "$dest" ]; then
    echo "[fix]  release/${name}.vsix が通常ファイルでないため除去して再配置します"
    rm -rf "$dest"
  fi
  # 検証済み temp を同一FS内 rename でアトミックに配置
  if ! mv -f "$tmp" "$dest" 2>/dev/null; then
    rm -f "$tmp"
    echo "[error] $name: release への配置に失敗。per-dir は掃除しません（source 保全）"
    manifest_rows+="| $name | $ver (配置失敗) | - |"$'\n'
    failed=$((failed + 1))
    continue
  fi

  size="$(du -h "$dest" 2>/dev/null | cut -f1)"
  echo "[ok]  $(basename "$src")  ->  release/${name}.vsix  (${size:-?})"

  # 検証成功後のみ per-dir のビルド成果物 VSIX を掃除（正は release/）
  removed="$(ls "$dir"/*.vsix 2>/dev/null | wc -l | tr -d ' ')"
  rm -f "$dir"/*.vsix
  echo "      cleaned per-dir vsix (${removed} 件)"

  manifest_rows+="| $name | $ver | ${name}.vsix |"$'\n'
  collected=$((collected + 1))
done

# VERSIONS.md を一括生成（途中中断で半端な manifest を残さない）
{
  echo "# Release VSIX 一覧（自動生成）"
  echo
  echo "各拡張の最新 VSIX を安定ファイル名で集約したもの。build 後に \`scripts/collect-vsix.sh\` で更新される。"
  echo "他リポジトリへ展開する際は \`release/<name>.vsix\` を参照すれば常に最新が得られる。"
  echo
  echo "| 拡張 | バージョン | 安定ファイル名 |"
  echo "|---|---|---|"
  printf '%s' "$manifest_rows"
} > "$REL/VERSIONS.md"

echo
echo "集約完了: ${collected} 更新 / ${already} 維持 -> ${REL}/"
[ "$missing" -gt 0 ] && echo "警告: ${missing} 拡張の VSIX が未検出（build/package を先に実行してください）"
[ "$failed" -gt 0 ] && echo "警告: ${failed} 拡張でエラー（package.json 欠如/コピー失敗等。上のログ参照）"
echo "一覧: release/VERSIONS.md"

# per-item のエラー（package.json 欠如・コピー失敗）があれば非ゼロで通知。未パッケージ(missing)は 0 のまま。
[ "$failed" -gt 0 ] && exit 1
exit 0
