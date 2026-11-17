#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

BINARY=src-tauri/target/release/okzmongo
BIN_DIR="$HOME/bin"
ICON_SRC=src-tauri/icons/128x128.png
ICON_DEST="$HOME/.local/share/icons/hicolor/128x128/apps/okzmongo.png"
DESKTOP_FILE="$HOME/.local/share/applications/okzmongo.desktop"

if [[ ! -f "$BINARY" ]]; then
  echo "エラー: バイナリが見つかりません。先に build.sh を実行してください。" >&2
  exit 1
fi

# ~/bin へバイナリ配置
mkdir -p "$BIN_DIR"
# 実行中でも置き換えられるよう、同じフォルダに一時ファイルを書いてから mv で差し替える
# （実行中のファイルへ直接書くと「テキストファイルがビジー状態です」で失敗するため）
TMP_BIN=$(mktemp "$BIN_DIR"/.okzmongo.XXXXXX)
cp "$BINARY" "$TMP_BIN"
chmod 755 "$TMP_BIN"
mv -f "$TMP_BIN" "$BIN_DIR"/okzmongo
echo "==> バイナリを $BIN_DIR/okzmongo に配置しました"

# アイコン配置
mkdir -p "$(dirname "$ICON_DEST")"
cp "$ICON_SRC" "$ICON_DEST"
echo "==> アイコンを $ICON_DEST に配置しました"

# .desktop ファイル作成
mkdir -p "$(dirname "$DESKTOP_FILE")"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=okzMongo
Comment=MongoDB GUI クライアント
Exec=env GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 $BIN_DIR/okzmongo
Icon=okzmongo
Categories=Development;Database;
Terminal=false
EOF
echo "==> デスクトップファイルを $DESKTOP_FILE に作成しました"

# デスクトップデータベース更新
if command -v update-desktop-database &>/dev/null; then
  update-desktop-database "$HOME/.local/share/applications"
fi
if command -v gtk-update-icon-cache &>/dev/null; then
  gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
fi

echo "==> インストール完了"

# PATH 未設定の場合に案内
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
  echo ""
  echo "注意: $BIN_DIR が PATH に含まれていません。"
  echo "  ~/.bashrc または ~/.zshrc に以下を追加してください:"
  echo "  export PATH=\"\$HOME/bin:\$PATH\""
fi
