# Sidekick CLI

The `sidekick` CLI runs a local Sidekick agent that connects to Sidekicks and executes work for your repositories.

## Quick Start

Install:

```bash
curl -fsSL https://raw.githubusercontent.com/sidekicks-sh/sidekick/main/install.sh | sh
```

Run:

```bash
sidekick start --detach
sidekick status
```

Stop:

```bash
sidekick stop
```

## CLI Commands

```bash
sidekick <command> [options]

Commands:
  start [--detach]  Start the sidekick worker
  status            Show current sidekick status
  stop              Stop the running sidekick
```

## Basic Configuration

Most users only need:

- `SIDEKICK_API_TOKEN` (your Sidekicks API token)
- `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` (if using default `internal` backend)

Example:

```bash
export SIDEKICK_API_TOKEN="your-token"
export OPENROUTER_API_KEY="your-openrouter-key"
export OPENROUTER_MODEL="openai/gpt-4.1-mini"
```

## Backend Options

- `SIDEKICK_AGENT=internal` (default): in-process OpenRouter backend.
- `SIDEKICK_AGENT=codex`: uses external `codex` CLI.
- `SIDEKICK_AGENT=claude`: uses external `claude` CLI.
- `SIDEKICK_AGENT=opencode`: uses external `opencode` CLI.

## Advanced Environment Variables

Core environment variables:

- `SIDEKICK_CONTROL_PLANE_URL` (default: `https://sidekicks.sh/api`)
- `SIDEKICK_API_TOKEN` (default: `mock-token`, set this for real usage)
- `SIDEKICK_REPOS_DIR` (default: `./repos`)
- `SIDEKICK_POLL_INTERVAL` (default: `10` seconds)
- `SIDEKICK_AGENT` (`internal|codex|claude|opencode`, default: `internal`)
- `SIDEKICK_PID_FILE` (default: `./sidekick.pid`)
- `SIDEKICK_LOG_FILE` (default: `./sidekick.log`)
- `SIDEKICK_LOG_BATCH_SIZE` (default: `20`)

## Running From Source (Advanced)

```bash
cd sidekicks-cli
bun install
bun run build
./dist/sidekick start --detach
```

Without compiling first:

```bash
bun run dev start
```

## Docker

Build and run with Docker:

```bash
docker build -f docker/Dockerfile -t sidekick:local .
docker run --rm \
  -e SIDEKICK_API_TOKEN="your-token" \
  -e OPENROUTER_API_KEY="your-openrouter-key" \
  -e OPENROUTER_MODEL="openai/gpt-4.1-mini" \
  -v "$HOME/.ssh:/home/sidekick/.ssh:ro" \
  -v "$HOME/.config/gh:/home/sidekick/.config/gh:ro" \
  -v "$HOME/.codex:/home/sidekick/.codex" \
  -v "$(pwd)/repos:/work/repos" \
  sidekick:local
```

Or use Docker Compose:

```bash
cp docker/.env.sidekick.example .env.sidekick
mkdir -p secrets repos logs
printf '%s' 'your-sidekick-token' > secrets/sidekick_api_token
printf '%s' 'your-openrouter-api-key' > secrets/openrouter_api_key
printf '%s' 'openai/gpt-4.1-mini' > secrets/openrouter_model
docker compose -f docker/compose.yaml up --build
```
