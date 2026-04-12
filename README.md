# Sidekicks CLI

The `sidekick` CLI runs the Sidekicks worker from your machine and manages auth, sidekick selection, daemon lifecycle, and task execution.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/sidekicks-sh/agent-cli/main/install.sh | sh
```

The installer downloads the latest compiled binary for your OS/architecture from GitHub Releases and installs it as `sidekick`.

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/sidekicks-sh/agent-cli/main/uninstall.sh | sh
```

Or, if you already have this repository locally:

```bash
./uninstall.sh
```

The uninstall script stops the daemon (if running) and removes the installed `sidekick` binary.

## Quick Start

Authenticate:

```bash
sidekick auth login
sidekick auth whoami
```

Create and select a sidekick:

```bash
sidekick sidekick create --name "Build Bot" --purpose "Implement and ship queued tasks" --select
```

Detect and set a local coding agent:

```bash
sidekick models detect
sidekick models set codex
# or
sidekick models set claude
```

Validate machine readiness:

```bash
sidekick doctor
```

Run in foreground:

```bash
sidekick run
```

Run in daemon mode:

```bash
sidekick daemon start
sidekick daemon status
sidekick daemon stop
```

## Command Surface

```bash
sidekick <command> [options]

Commands:
  auth     Authentication commands
  sidekick Sidekick management commands
  task     Task management commands
  doctor   Local readiness checks
  config   Local config management
  models   Local agent model selection
  daemon   Detached lifecycle management (start/status/stop)
  run      Worker loop in foreground mode
```

Global flags:

- `--json`: emit one machine-readable JSON object to stdout
- `--non-interactive`: disable prompts
- `--yes`: auto-confirm prompts

## Daemon Lifecycle Notes

- `sidekick daemon start` requires an authenticated session.
- `sidekick daemon status` and `sidekick daemon stop` are local-state operations and can succeed unauthenticated.
- `sidekick daemon stop` is idempotent.

## Task Creation Scope

`sidekick task create` requires both project and repository scope.

Supported inputs today:

- Explicit IDs: `--project-id` and `--repository-id`
- Lookup flags: `--project-name` and `--repository-url`

Example (explicit IDs):

```bash
sidekick task create \
  --project-id "<project-id>" \
  --repository-id "<repository-id>" \
  --title "Fix failing CI check" \
  --description "Investigate and resolve lint failure in runner flow"
```
