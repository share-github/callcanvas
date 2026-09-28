#!/usr/bin/env bash
# Run the end-to-end test against a real LazyVim configuration.
#
# Builds a throwaway copy of the user's ~/.config/nvim (NVIM_APPNAME based) with
# lazyvim/callcanvas.lua dropped in, so the user's own config is never touched,
# then runs test/e2e-nvim.sh against it.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$HERE/.." && pwd)"
APPNAME="${CALLCANVAS_LAZYVIM_APPNAME:-cc-lazyvim-e2e}"
SOURCE_CONFIG="${CALLCANVAS_SOURCE_CONFIG:-$HOME/.config/nvim}"

CONFIG_DIR="$HOME/.config/$APPNAME"
DATA_LINK="$HOME/.local/share/$APPNAME"

if [[ ! -f "$SOURCE_CONFIG/lua/config/lazy.lua" ]]; then
    echo "SKIP: no LazyVim configuration at $SOURCE_CONFIG"
    exit 0
fi

cleanup_config() {
    rm -rf "$CONFIG_DIR"
    rm -f "$DATA_LINK"
}
trap cleanup_config EXIT

cleanup_config
cp -r "$SOURCE_CONFIG" "$CONFIG_DIR"
mkdir -p "$CONFIG_DIR/lua/plugins"
cp "$PLUGIN_DIR/lazyvim/callcanvas.lua" "$CONFIG_DIR/lua/plugins/callcanvas.lua"
# Reuse the already-installed plugins instead of cloning them again.
ln -sfn "$HOME/.local/share/nvim" "$DATA_LINK"

echo "LazyVim e2e: NVIM_APPNAME=$APPNAME (config copied from $SOURCE_CONFIG)"
CALLCANVAS_TEST_APPNAME="$APPNAME" "$HERE/e2e-nvim.sh" "$@"
