#!/bin/sh
# Installs the backupd CLI: https://backupd.dev/cli
#
#   curl -fsSL https://backupd.dev/install | sh
#
# Options, as environment variables:
#   BACKUPD_VERSION       a version like 0.1.0 (default: the latest release)
#   BACKUPD_INSTALL_DIR   where to put the binary (default: ~/.backupd/bin)
#
# It downloads one binary from the GitHub release, checks it against the
# release's SHA256SUMS, and puts it in BACKUPD_INSTALL_DIR. It doesn't need
# root and doesn't edit your shell profile; it tells you what to add.
set -eu

REPO="backupd-dev/backupd-js"
BASE_URL="${BACKUPD_DOWNLOAD_URL:-https://github.com/$REPO/releases}"
INSTALL_DIR="${BACKUPD_INSTALL_DIR:-$HOME/.backupd/bin}"

say() { printf '%s\n' "$*" >&2; }
fail() {
  say "error: $*"
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "curl or wget is required"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "sha256sum or shasum is required to verify the download"
  fi
}

case "$(uname -s)" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  MINGW* | MSYS* | CYGWIN*) fail "on Windows, run: irm https://backupd.dev/install.ps1 | iex" ;;
  *) fail "unsupported OS: $(uname -s). Use npm instead: npm i -g @backupd/cli" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) fail "unsupported CPU: $(uname -m). Use npm instead: npm i -g @backupd/cli" ;;
esac

# An x64 shell on Apple silicon (Rosetta) should still get the native binary.
if [ "$os" = "darwin" ] && [ "$arch" = "x64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  arch="arm64"
fi

# Alpine and other musl-based systems need the musl build.
libc=""
if [ "$os" = "linux" ]; then
  if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then
    libc="-musl"
  fi
fi

asset="backupd-$os-$arch$libc"
if [ -n "${BACKUPD_VERSION:-}" ]; then
  url="$BASE_URL/download/v${BACKUPD_VERSION#v}"
else
  url="$BASE_URL/latest/download"
fi

need uname
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading $asset…"
download "$url/$asset" "$tmp/backupd" || fail "couldn't download $url/$asset"
download "$url/SHA256SUMS" "$tmp/SHA256SUMS" || fail "couldn't download the checksums"

expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d ' ' -f 1)"
[ -n "$expected" ] || fail "no checksum for $asset in the release"
actual="$(sha256 "$tmp/backupd")"
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual)"

mkdir -p "$INSTALL_DIR"
chmod 755 "$tmp/backupd"
mv "$tmp/backupd" "$INSTALL_DIR/backupd"

if ! version="$("$INSTALL_DIR/backupd" --version 2>/dev/null)"; then
  version="backupd"
  if [ -n "$libc" ]; then
    say ""
    say "backupd needs the C++ runtime on this system. On Alpine: apk add libstdc++ libgcc"
  fi
fi
say ""
say "Installed $version to $INSTALL_DIR/backupd"

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    say ""
    say "Get started: backupd login"
    ;;
  *)
    case "${SHELL:-}" in
      */zsh) profile="~/.zshrc" ;;
      */bash) profile="~/.bashrc" ;;
      */fish) profile="~/.config/fish/config.fish" ;;
      *) profile="your shell profile" ;;
    esac
    say ""
    say "Add it to your PATH, in $profile:"
    if [ "$profile" = "~/.config/fish/config.fish" ]; then
      say "  fish_add_path $INSTALL_DIR"
    else
      say "  export PATH=\"$INSTALL_DIR:\$PATH\""
    fi
    say ""
    say "Then: backupd login"
    ;;
esac
