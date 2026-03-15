import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { StructuredLogger } from "../src/logging";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("structured logger", () => {
  it("writes log lines to file by default without stderr mirroring", async () => {
    const fixture = createLoggerFixture();

    const logger = new StructuredLogger({
      logFile: fixture.logFile,
      logBatchSize: 20,
      mirrorToStderr: false,
      writeMirrorLine: (line) => {
        fixture.mirroredLines.push(line);
      },
      getContext: () => ({
        sidekickId: "sidekick-001",
        sidekickName: "sidekick",
        status: "booting",
      }),
    });

    await logger.info("runtime", "hello world");

    const lines = readStructuredLogLines(fixture.logFile);
    expect(lines.length).toBe(1);
    expect(lines[0].event).toBe("runtime");
    expect(lines[0].message).toBe("hello world");
    expect(fixture.mirroredLines).toHaveLength(0);
  });

  it("mirrors log lines to stderr in addition to writing the log file", async () => {
    const fixture = createLoggerFixture();

    const logger = new StructuredLogger({
      logFile: fixture.logFile,
      logBatchSize: 20,
      mirrorToStderr: true,
      writeMirrorLine: (line) => {
        fixture.mirroredLines.push(line);
      },
      getContext: () => ({
        sidekickId: "sidekick-001",
        sidekickName: "sidekick",
        status: "working",
        taskId: "task-1",
        runId: "run-1",
      }),
    });

    await logger.info("agent_output", "line one");

    const lines = readStructuredLogLines(fixture.logFile);
    expect(lines.length).toBe(1);
    expect(fixture.mirroredLines).toHaveLength(1);
    const mirrored = JSON.parse(fixture.mirroredLines[0]) as {
      message?: string;
    };
    expect(mirrored.message).toBe("line one");
  });
});

function createLoggerFixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "sidekick-logging-test-"));
  tempDirs.push(rootDir);

  return {
    logFile: join(rootDir, "sidekick.log"),
    mirroredLines: [] as string[],
  };
}

function readStructuredLogLines(
  logFile: string,
): Array<Record<string, string>> {
  const raw = readFileSync(logFile, "utf8").trim();
  if (!raw) {
    return [];
  }

  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, string>);
}
