# Docker

Unified container runtime for the compiled `sidekick` executable.

## Auth Layout

- GitHub CLI config: `/home/sidekick/.config/gh`
- Codex config: `/home/sidekick/.codex`
- SSH keys/config: `/home/sidekick/.ssh`
- Token env vars:
  - `SIDEKICK_API_TOKEN`
  - `GH_TOKEN` or `GITHUB_TOKEN`
  - `OPENROUTER_API_KEY`
  - `OPENROUTER_MODEL`
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `OPENCODE_API_KEY`
- Token file env vars:
  - `*_FILE` variants for each token above
- Default Docker secret paths:
  - `/run/secrets/sidekick_api_token`
  - `/run/secrets/gh_token`
  - `/run/secrets/github_token`
  - `/run/secrets/openrouter_api_key`
  - `/run/secrets/openrouter_model`
  - `/run/secrets/openai_api_key`
  - `/run/secrets/anthropic_api_key`
  - `/run/secrets/opencode_api_key`

Entrypoint behavior:

- loads `*_FILE` secrets and default `/run/secrets/*` values
- prepares auth/runtime directory layout
- validates auth inputs and prints startup warnings for missing credentials
- starts `sidekick start` by default

## Build And Run

```bash
docker build -f docker/Dockerfile -t sidekick:local ..
docker run --rm \
  --env-file .env.sidekick \
  -v "$HOME/.ssh:/home/sidekick/.ssh:ro" \
  -v "$HOME/.config/gh:/home/sidekick/.config/gh:ro" \
  -v "$HOME/.codex:/home/sidekick/.codex" \
  -v "$(pwd)/repos:/work/repos" \
  sidekick:local
```

## Compose

```bash
cp .env.sidekick.example .env.sidekick
mkdir -p secrets repos logs
printf '%s' 'your-sidekick-token' > secrets/sidekick_api_token
printf '%s' 'your-openrouter-api-key' > secrets/openrouter_api_key
printf '%s' 'openai/gpt-4.1-mini' > secrets/openrouter_model
docker compose up --build
```

Health check command:

```bash
/opt/sidekick/sidekick status
```

## Smoke Test

Run build/start/status validation in one command:

```bash
bun run docker:smoke
```
