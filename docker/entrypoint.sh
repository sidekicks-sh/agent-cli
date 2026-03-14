#!/usr/bin/env bash
set -euo pipefail

load_secret_file() {
  local var_name="$1"
  local file_var="${var_name}_FILE"
  local file_path="${!file_var:-}"

  if [[ -z "${file_path}" ]]; then
    return 0
  fi

  if [[ ! -r "${file_path}" ]]; then
    echo "Secret file for ${var_name} is not readable: ${file_path}" >&2
    exit 1
  fi

  export "${var_name}=$(<"${file_path}")"
}

maybe_load_default_secret() {
  local var_name="$1"
  local secret_name="$2"
  local secret_path="/run/secrets/${secret_name}"
  local file_var="${var_name}_FILE"

  if [[ -n "${!var_name:-}" || -n "${!file_var:-}" ]]; then
    return 0
  fi

  if [[ -r "${secret_path}" ]]; then
    export "${var_name}=$(<"${secret_path}")"
  fi
}

warn_missing_auth() {
  local message="$1"
  echo "Auth warning: ${message}" >&2
}

prepare_auth_layout() {
  mkdir -p \
    "${HOME}/.ssh" \
    "${GH_CONFIG_DIR}" \
    "${CODEX_HOME}" \
    "${SIDEKICK_REPOS_DIR}" \
    "$(dirname "${SIDEKICK_PID_FILE}")" \
    "$(dirname "${SIDEKICK_LOG_FILE}")"
  chmod 700 "${HOME}/.ssh" "${GH_CONFIG_DIR}" "${CODEX_HOME}" || true
}

validate_auth() {
  local agent="${SIDEKICK_AGENT:-custom}"

  if [[ -z "${SIDEKICK_API_TOKEN:-}" ]]; then
    warn_missing_auth "SIDEKICK_API_TOKEN is unset; control plane requests will fail."
  fi

  if [[ -z "${GH_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" && ! -s "${GH_CONFIG_DIR}/hosts.yml" ]]; then
    warn_missing_auth "GitHub auth not found. Set GH_TOKEN/GITHUB_TOKEN or mount ${GH_CONFIG_DIR}."
  fi

  case "${agent}" in
    custom)
      if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
        warn_missing_auth "OPENROUTER_API_KEY is unset; custom backend will fail."
      fi
      if [[ -z "${OPENROUTER_MODEL:-}" ]]; then
        warn_missing_auth "OPENROUTER_MODEL is unset; custom backend will fail."
      fi
      ;;
    codex)
      if [[ -z "${OPENAI_API_KEY:-}" && -z "$(find "${CODEX_HOME}" -mindepth 1 -maxdepth 1 2>/dev/null)" ]]; then
        warn_missing_auth "Codex auth not found. Set OPENAI_API_KEY or mount ${CODEX_HOME}."
      fi
      ;;
    claude)
      if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
        warn_missing_auth "ANTHROPIC_API_KEY is unset; claude backend may fail."
      fi
      ;;
    opencode)
      if [[ -z "${OPENCODE_API_KEY:-}" && -z "${OPENROUTER_API_KEY:-}" ]]; then
        warn_missing_auth "Set OPENCODE_API_KEY or OPENROUTER_API_KEY for opencode backend auth."
      fi
      ;;
  esac
}

load_secret_file "SIDEKICK_API_TOKEN"
load_secret_file "GH_TOKEN"
load_secret_file "GITHUB_TOKEN"
load_secret_file "OPENAI_API_KEY"
load_secret_file "OPENROUTER_API_KEY"
load_secret_file "OPENROUTER_MODEL"
load_secret_file "ANTHROPIC_API_KEY"
load_secret_file "OPENCODE_API_KEY"

maybe_load_default_secret "SIDEKICK_API_TOKEN" "sidekick_api_token"
maybe_load_default_secret "GH_TOKEN" "gh_token"
maybe_load_default_secret "GITHUB_TOKEN" "github_token"
maybe_load_default_secret "OPENAI_API_KEY" "openai_api_key"
maybe_load_default_secret "OPENROUTER_API_KEY" "openrouter_api_key"
maybe_load_default_secret "OPENROUTER_MODEL" "openrouter_model"
maybe_load_default_secret "ANTHROPIC_API_KEY" "anthropic_api_key"
maybe_load_default_secret "OPENCODE_API_KEY" "opencode_api_key"

prepare_auth_layout
validate_auth

if [[ $# -eq 0 ]]; then
  set -- start
fi

if [[ "${1}" == "run" ]]; then
  shift
  set -- start "$@"
fi

exec "${SIDEKICK_HOME}/sidekick" "$@"
