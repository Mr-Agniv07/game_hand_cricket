#!/usr/bin/env bash
# Downloads the right Cric Flick CLI binary for this machine and runs it.
#   curl -fsSL https://raw.githubusercontent.com/Mr-Agniv07/game_hand_cricket/master/cli/install.sh | bash
set -euo pipefail

REPO="Mr-Agniv07/game_hand_cricket"
INSTALL_DIR="${CRICFLICK_INSTALL_DIR:-$HOME/.cricflick-cli}"
BIN_PATH="$INSTALL_DIR/cricflick-cli"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin)
    case "$arch" in
      arm64) asset="cricflick-cli-macos-arm64" ;;
      x86_64) asset="cricflick-cli-macos-x64" ;;
      *)
        echo "Unsupported macOS architecture: $arch" >&2
        exit 1
        ;;
    esac
    ;;
  Linux)
    case "$arch" in
      x86_64) asset="cricflick-cli-linux-x64" ;;
      *)
        echo "Unsupported Linux architecture: $arch (only x64 builds are published)" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "Unsupported OS: $os" >&2
    echo "Windows users: download cricflick-cli-windows-x64.exe directly from" >&2
    echo "https://github.com/$REPO/releases/latest" >&2
    exit 1
    ;;
esac

url="https://github.com/$REPO/releases/latest/download/$asset"

mkdir -p "$INSTALL_DIR"
echo "Downloading Cric Flick CLI ($asset)..." >&2
curl -fsSL -o "$BIN_PATH" "$url"
chmod +x "$BIN_PATH"

if [ "$os" = "Darwin" ]; then
  xattr -d com.apple.quarantine "$BIN_PATH" 2>/dev/null || true
fi

# When invoked as `curl ... | bash`, this script's own stdin is the pipe
# carrying the script source, not the user's keyboard — without this
# redirect the CLI's interactive prompts would read from (and immediately
# hit EOF on) that pipe instead of the real terminal.
exec "$BIN_PATH" < /dev/tty
