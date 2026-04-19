# Sidekicks CLI

`sidekicks` allows you (or an agent) to interact with sidekicks.sh from the command line.

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

## Command Surface

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

### List Resources With `sidekicks list-*`

List the resources available in your Sidekicks account. These commands require an authenticated session.

```bash
sidekicks list-sidekicks
sidekicks list-tasks
sidekicks list-projects
sidekicks list-repositories
```

`sidekicks list-repos` is also available as an alias for `sidekicks list-repositories`.

Use `--json` if you want machine-readable output instead of the default table output:

```bash
sidekicks list-sidekicks --json
```

### View Resources With `sidekicks get-*`

View a single sidekick, task, project, or repository by id. These commands require an authenticated session and take the resource id via `--id`.

```bash
sidekicks get-sidekick --id <id>
sidekicks get-task --id <id>
sidekicks get-project --id <id>
sidekicks get-repository --id <id>
```

`sidekicks get-repo --id <id>` is also available as an alias for `sidekicks get-repository --id <id>`.

Use `--json` here as well if you want JSON output:

```bash
sidekicks get-task --id <id> --json
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
- `SIDEKICKS_HOME`: override the Sidekicks local home directory. The session file is resolved from here.
