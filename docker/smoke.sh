#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE_TAG="${1:-sidekick:smoke}"
CONTAINER_NAME="sidekick-smoke-$$"

cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[smoke] Building image ${IMAGE_TAG}"
docker build -f "${PROJECT_DIR}/docker/Dockerfile" -t "${IMAGE_TAG}" "${PROJECT_DIR}"

echo "[smoke] Starting container ${CONTAINER_NAME}"
docker run -d --rm \
  --name "${CONTAINER_NAME}" \
  -e SIDEKICK_CONTROL_PLANE_URL="http://127.0.0.1:65535/api" \
  -e SIDEKICK_API_TOKEN="smoke-test-token" \
  -e OPENROUTER_API_KEY="smoke-test-openrouter-key" \
  -e OPENROUTER_MODEL="openai/gpt-4.1-mini" \
  "${IMAGE_TAG}" >/dev/null

for _ in $(seq 1 30); do
  if docker exec "${CONTAINER_NAME}" /opt/sidekick/sidekick status >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[smoke] Verifying daemon status inside container"
docker exec "${CONTAINER_NAME}" /opt/sidekick/sidekick status

echo "[smoke] Recent container logs"
docker logs --tail 20 "${CONTAINER_NAME}" || true

echo "[smoke] PASS"
