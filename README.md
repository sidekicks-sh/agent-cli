# Sidekick

Unified Sidekicks runtime in a single TypeScript/Bun package.

`sidekick` combines the old split workflow (`agent`, `daemon`, `image`) into one executable project with one source of truth for config, runtime behavior, packaging, and container deployment.

## Requirements

- Bun `>=1.3`
- `git`, `gh`
- Optional backend CLIs when using external backends:
  - `codex`
  - `claude`
  - `opencode`

## Quick Start (Local)

```bash
cd sidekick
bun install
bun run build

# Minimum env for local run
export SIDEKICK_API_TOKEN="your-token"
export SIDEKICK_CONTROL_PLANE_URL="https://sidekicks.sh/api"

# Default backend is custom (OpenRouter)
export OPENROUTER_API_KEY="your-openrouter-key"
export OPENROUTER_MODEL="openai/gpt-4.1-mini"

./dist/sidekick start --detach
./dist/sidekick status
./dist/sidekick stop
```

To run from source without compiling first:

```bash
bun run dev start
```

## CLI

```text
sidekick <command> [options]

Commands:
  start [--detach]
  status
  stop
```

## Environment Configuration

Core environment variables:

- `SIDEKICK_CONTROL_PLANE_URL` (default: `https://sidekicks.sh/api`)
- `SIDEKICK_API_TOKEN` (default: `mock-token`)
- `SIDEKICK_ID` (default: `sidekick-001`)
- `SIDEKICK_REPOS_DIR` (default: `./repos`)
- `SIDEKICK_POLL_INTERVAL` (default: `10` seconds)
- `SIDEKICK_AGENT` (`custom|codex|claude|opencode`, default: `custom`)
- `SIDEKICK_PID_FILE` (default: `./sidekick.pid`)
- `SIDEKICK_LOG_FILE` (default: `./sidekick.log`)
- `SIDEKICK_LOG_BATCH_SIZE` (default: `20`)

## Backend Configuration

`SIDEKICK_AGENT=custom` (default):
- Uses in-process OpenRouter backend.
- Required: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`.

`SIDEKICK_AGENT=codex`:
- Uses external `codex` CLI.
- Provide `OPENAI_API_KEY` or mount Codex auth config (`CODEX_HOME`).

`SIDEKICK_AGENT=claude`:
- Uses external `claude` CLI.
- Typically requires `ANTHROPIC_API_KEY`.

`SIDEKICK_AGENT=opencode`:
- Uses external `opencode` CLI.
- Requires `OPENCODE_API_KEY` or OpenRouter auth.

## Docker

See [docker/README.md](./docker/README.md) for container usage.

Quick path:

```bash
cd sidekick/docker
cp .env.sidekick.example .env.sidekick
mkdir -p secrets repos logs
printf '%s' 'your-sidekick-token' > secrets/sidekick_api_token
printf '%s' 'your-openrouter-api-key' > secrets/openrouter_api_key
printf '%s' 'openai/gpt-4.1-mini' > secrets/openrouter_model
docker compose up --build
```

Smoke test:

```bash
bun run docker:smoke
```

## Build And Release

Local build:

```bash
bun run build
./dist/sidekick --help
```

Release artifacts:

```bash
bun run build:release
```

Install script:

```bash
curl -fsSL https://raw.githubusercontent.com/sidekicks-sh/sidekick/main/install.sh | sh
```

## Documentation

- [Operations Guide](./docs/operations.md)
- [Architecture](./docs/architecture.md)
- [Migration Notes](./docs/migration.md)
- [Backlog](./docs/backlog.md)
