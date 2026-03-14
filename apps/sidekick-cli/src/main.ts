#!/usr/bin/env bun

import packageJson from "../../../package.json" with { type: "json" };

import { readConfig } from "../../../src/config";
import {
  getDaemonStatus,
  runForegroundScaffold,
  startDetached,
  stopDaemon,
} from "../../../src/daemon";

type Command = "start" | "status" | "stop";

const HELP_TEXT = `sidekick <command> [options]

Commands:
  start [--detach]   Start the sidekick daemon
  status             Show daemon status
  stop               Stop the daemon

Options:
  -h, --help         Show help
  -v, --version      Show version

Start options:
  -d, --detach       Start daemon in background
      --no-detach    Internal flag for detached re-exec
      --log-file     Override log file path`;

interface CliOptions {
  command?: Command;
  detach: boolean;
  noDetach: boolean;
  logFile?: string;
}

function isCommand(value: string): value is Command {
  return value === "start" || value === "status" || value === "stop";
}

function parseCliOptions(command: Command, args: string[]): CliOptions {
  const parsed: CliOptions = {
    command,
    detach: false,
    noDetach: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "-d" || arg === "--detach") {
      parsed.detach = true;
      continue;
    }

    if (arg === "--no-detach") {
      parsed.noDetach = true;
      continue;
    }

    if (arg === "--log-file") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--log-file requires a path");
      }
      parsed.logFile = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option for '${command}': ${arg}`);
  }

  return parsed;
}

async function startCommand(options: CliOptions) {
  const config = readConfig(process.env, {
    logFile: options.logFile,
  });

  if (options.detach && !options.noDetach) {
    const result = await startDetached(config, process.argv, process.execPath);
    if (result.alreadyRunning) {
      console.log(`sidekick already running (pid ${result.pid})`);
      return 0;
    }

    console.log(`sidekick started in background (pid ${result.pid})`);
    console.log(`logs: ${config.logFile}`);
    return 0;
  }

  console.log(`sidekick started (pid ${process.pid})`);
  console.log(`logs: ${config.logFile}`);
  await runForegroundScaffold(config);
  return 0;
}

async function statusCommand(options: CliOptions) {
  const config = readConfig(process.env, {
    logFile: options.logFile,
  });
  const status = await getDaemonStatus(config);

  if (status.running) {
    console.log(`sidekick is running (pid ${status.pid})`);
    return 0;
  }

  if (status.stalePidFile) {
    console.log(`sidekick is not running (stale pid file: ${status.pidFile})`);
    return 1;
  }

  console.log("sidekick is not running");
  return 1;
}

async function stopCommand(options: CliOptions) {
  const config = readConfig(process.env, {
    logFile: options.logFile,
  });
  const result = await stopDaemon(config);
  if (!result.stopped) {
    console.error(result.message);
    return 1;
  }

  console.log(result.message);
  return 0;
}

async function main(argv: string[]) {
  const [first, ...rest] = argv;

  if (!first || first === "-h" || first === "--help") {
    console.log(HELP_TEXT);
    return 0;
  }

  if (first === "-v" || first === "--version") {
    console.log(packageJson.version);
    return 0;
  }

  if (!isCommand(first)) {
    console.error(`sidekick: unknown command '${first}'`);
    console.error(HELP_TEXT);
    return 1;
  }

  const options = parseCliOptions(first, rest);

  switch (first) {
    case "start":
      return startCommand(options);
    case "status":
      return statusCommand(options);
    case "stop":
      return stopCommand(options);
  }
}

main(process.argv.slice(2))
  .then((exitCode) => {
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`sidekick: ${message}`);
    process.exit(1);
  });
