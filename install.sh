#!/usr/bin/env sh

set -eu

REPO="${REPO:-sidekicks-sh/sidekick}"
INSTALL_DIR="${INSTALL_DIR:-}"
BIN_NAME="sidekick"

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

detect_os() {
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$os" in
    linux)
      printf 'linux\n'
      ;;
    darwin)
      printf 'darwin\n'
      ;;
    *)
      fail "unsupported operating system: $os"
      ;;
  esac
}

detect_arch() {
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64)
      printf 'x64\n'
      ;;
    arm64|aarch64)
      printf 'arm64\n'
      ;;
    *)
      fail "unsupported architecture: $arch"
      ;;
  esac
}

asset_name() {
  os="$1"
  arch="$2"

  case "$os/$arch" in
    linux/x64)
      printf '%s\n' "${BIN_NAME}-linux-x64"
      ;;
    darwin/x64)
      printf '%s\n' "${BIN_NAME}-darwin-x64"
      ;;
    darwin/arm64)
      printf '%s\n' "${BIN_NAME}-darwin-arm64"
      ;;
    *)
      fail "no release artifact for ${os}/${arch}"
      ;;
  esac
}

download() {
  url="$1"
  dest="$2"

  if need_cmd curl; then
    curl -fsSL "$url" -o "$dest"
    return
  fi

  if need_cmd wget; then
    wget -qO "$dest" "$url"
    return
  fi

  fail "curl or wget is required"
}

resolve_install_dir() {
  if [ -n "$INSTALL_DIR" ]; then
    printf '%s\n' "$INSTALL_DIR"
    return
  fi

  if [ -w /usr/local/bin ]; then
    printf '/usr/local/bin\n'
    return
  fi

  printf '%s\n' "$HOME/.local/bin"
}

install_binary() {
  src="$1"
  dest_dir="$2"
  dest_path="${dest_dir}/${BIN_NAME}"

  mkdir -p "$dest_dir"

  if [ -w "$dest_dir" ]; then
    install -m 0755 "$src" "$dest_path"
    return
  fi

  if need_cmd sudo; then
    sudo mkdir -p "$dest_dir"
    sudo install -m 0755 "$src" "$dest_path"
    return
  fi

  fail "cannot write to ${dest_dir}; set INSTALL_DIR to a writable path"
}

attempt_stop_existing_sidekick() {
  install_path="$1"

  if [ -x "$install_path" ]; then
    log "Stopping any running ${BIN_NAME} process via ${install_path}..."
    "$install_path" stop >/dev/null 2>&1 || true
  fi

  if need_cmd "$BIN_NAME"; then
    path_bin="$(command -v "$BIN_NAME" || true)"
    if [ -n "$path_bin" ] && [ "$path_bin" != "$install_path" ]; then
      log "Stopping any running ${BIN_NAME} process via ${path_bin}..."
      "$BIN_NAME" stop >/dev/null 2>&1 || true
    fi
  fi
}

main() {
  os="$(detect_os)"
  arch="$(detect_arch)"
  asset="$(asset_name "$os" "$arch")"
  dest_dir="$(resolve_install_dir)"
  install_path="${dest_dir}/${BIN_NAME}"
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM

  url="https://github.com/${REPO}/releases/latest/download/${asset}"
  archive_path="${tmp_dir}/${asset}"

  attempt_stop_existing_sidekick "$install_path"

  log "Downloading ${asset} from ${url}"
  download "$url" "$archive_path"

  install_binary "$archive_path" "$dest_dir"

  log "Installed ${BIN_NAME} to ${dest_dir}/${BIN_NAME}"
  case ":$PATH:" in
    *":${dest_dir}:"*)
      ;;
    *)
      log "Add ${dest_dir} to your PATH if it is not already available."
      ;;
  esac

  log "Run '${BIN_NAME} --help' to verify the install."
}

main "$@"
