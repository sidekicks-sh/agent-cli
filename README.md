# Sidekicks CLI

`sidekicks-cli` is the wrapper repository for the published `sidekicks` binary built from `sidekicks-monorepo/apps/cli`.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/sidekicks-sh/cli/main/install.sh | sh
```

The installer downloads the latest release artifact for your OS and architecture and installs it as `sidekicks`.

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/sidekicks-sh/cli/main/uninstall.sh | sh
```

If you already cloned this repository:

```bash
./uninstall.sh
```

## Current Command Surface

The CLI package is still in progress. These are the commands currently implemented in `sidekicks-monorepo/apps/cli`.

### `sidekicks login`

Start device authorization for this machine and store the session in `~/.sidekicks/session.json`.

```bash
sidekicks login
```

### `sidekicks logout`

Clear the saved session and attempt a server-side logout if a token is present.

```bash
sidekicks logout
```

### `sidekicks --help`

Show the current command list and usage.

```bash
sidekicks --help
```

### `sidekicks --version`

Show the current CLI version.

```bash
sidekicks --version
```

## Configuration

- `SIDEKICKS_API_BASE_URL`: override the API base URL. Default: `https://api.sidekicks.sh`

## Status

Additional CLI commands will be documented here as `sidekicks-monorepo/apps/cli` is completed.
