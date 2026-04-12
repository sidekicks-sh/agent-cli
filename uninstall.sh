#!/usr/bin/env sh

set -eu

INSTALL_DIR="${INSTALL_DIR:-}"
BIN_NAME="sidekick"

log() {
  printf '%s\n' "$*"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1
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

stop_daemon() {
  bin_path="$1"

  if [ -x "$bin_path" ]; then
    log "Stopping any running ${BIN_NAME} process via ${bin_path}..."
    "$bin_path" daemon stop >/dev/null 2>&1 || true
  fi
}

remove_binary() {
  bin_path="$1"

  if [ ! -e "$bin_path" ]; then
    return
  fi

  if [ -w "$bin_path" ] || [ -w "$(dirname "$bin_path")" ]; then
    rm -f "$bin_path"
    log "Removed ${bin_path}"
    return
  fi

  if need_cmd sudo; then
    sudo rm -f "$bin_path"
    log "Removed ${bin_path}"
    return
  fi

  log "Unable to remove ${bin_path}; try with sudo or set INSTALL_DIR."
}

main() {
  removed=0
  dest_dir="$(resolve_install_dir)"
  install_path="${dest_dir}/${BIN_NAME}"

  stop_daemon "$install_path"
  if need_cmd "$BIN_NAME"; then
    path_bin="$(command -v "$BIN_NAME" || true)"
    if [ -n "$path_bin" ] && [ "$path_bin" != "$install_path" ]; then
      stop_daemon "$path_bin"
    fi
  fi

  if [ -e "$install_path" ]; then
    remove_binary "$install_path"
    removed=1
  fi

  if need_cmd "$BIN_NAME"; then
    path_bin="$(command -v "$BIN_NAME" || true)"
    if [ -n "$path_bin" ] && [ "$path_bin" != "$install_path" ] && [ -e "$path_bin" ]; then
      remove_binary "$path_bin"
      removed=1
    fi
  fi

  if [ "$removed" -eq 0 ]; then
    log "No ${BIN_NAME} binary found to remove."
    return
  fi

  log "Uninstall complete."
}

main "$@"
