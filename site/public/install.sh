#!/bin/sh
# Delta Harness installer — downloads the right prebuilt binary from GitHub Releases.
#   curl -fsSL https://deltaharness.dev/install.sh | sh
set -eu

REPO="Carrara-Labs/delta-harness"
BIN="delta"
PREFIX="${PREFIX:-/usr/local/bin}"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$os" in
  linux) os="linux" ;;
  darwin) os="darwin" ;;
  *) echo "unsupported OS: $os (grab a binary from https://github.com/$REPO/releases)"; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) echo "unsupported arch: $arch"; exit 1 ;;
esac

asset="delta-bun-${os}-${arch}"
tag="${DELTA_VERSION:-latest}"
if [ "$tag" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$asset"
else
  url="https://github.com/$REPO/releases/download/$tag/$asset"
fi

tmp="$(mktemp)"
echo "Downloading $asset ..."
curl -fsSL "$url" -o "$tmp"
chmod +x "$tmp"

if [ -w "$PREFIX" ]; then
  mv "$tmp" "$PREFIX/$BIN"
else
  echo "Installing to $PREFIX (needs sudo)"
  sudo mv "$tmp" "$PREFIX/$BIN"
fi

echo "Installed $BIN to $PREFIX/$BIN"
"$PREFIX/$BIN" --version 2>/dev/null || true
