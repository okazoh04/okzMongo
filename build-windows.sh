#!/usr/bin/env bash
# Linux 上から Windows (x86_64-pc-windows-msvc) 向けにクロスコンパイルする。
# 必要: cargo-xwin, clang(clang-cl), llvm-rc, llvm-lib, lld-link, rustup target
# 初回は Windows SDK/CRT を ~/.cache/cargo-xwin にダウンロードする。
# 使い方: ./build-windows.sh           # 実行ファイル(.exe)のみ
#         ./build-windows.sh --nsis    # NSIS インストーラも生成(makensis が必要)
set -euo pipefail

cd "$(dirname "$0")"

TARGET=x86_64-pc-windows-msvc

# lld-link が無い場合は rustup 同梱の rust-lld を流用する
if ! command -v lld-link >/dev/null 2>&1; then
  SR="$(rustc --print sysroot)"
  mkdir -p "$HOME/.cargo/bin"
  ln -sf "$SR/lib/rustlib/x86_64-unknown-linux-gnu/bin/rust-lld" "$HOME/.cargo/bin/lld-link"
fi

rustup target add "$TARGET"

# 同意ライセンスの確認プロンプトを回避
export XWIN_ACCEPT_LICENSE=1

echo "==> okzMongo Windows ビルド開始 ($TARGET)"

if [[ "${1:-}" == "--nsis" ]]; then
  # Linux 版 tauri-cli は --bundles に nsis を受け付けないため、設定の上書きで指定する
  cargo tauri build --runner cargo-xwin --target "$TARGET" --config '{"bundle":{"targets":["nsis"]}}'
else
  cargo tauri build --runner cargo-xwin --target "$TARGET" --no-bundle
fi

echo "==> ビルド完了"
echo "    バイナリ: src-tauri/target/$TARGET/release/okzmongo.exe"
