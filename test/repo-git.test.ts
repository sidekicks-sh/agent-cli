import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { finalizeTaskChanges } from "../src/git";
import { prepareTaskRepository } from "../src/repo";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("repo preparation", () => {
  it("prepares execution branch for new and existing remote branches", async () => {
    const seeded = createSeededRemoteRepository();
    const reposDir = createTempDir("sidekick-m4-repos-");
    const executionBranch = "sidekick/task-1";

    const firstRun = await prepareTaskRepository({
      reposDir,
      repoName: "repo",
      repoUrl: seeded.remotePath,
      baseBranch: "main",
      executionBranch,
    });

    expect(firstRun.cloned).toBe(true);
    expect(firstRun.executionBranchMode).toBe("created_from_base");
    expect(
      runChecked("git", ["branch", "--show-current"], {
        cwd: firstRun.repoPath,
      }),
    ).toBe(executionBranch);

    runChecked("git", ["config", "user.email", "sidekick@example.com"], {
      cwd: firstRun.repoPath,
    });
    runChecked("git", ["config", "user.name", "Sidekick"], {
      cwd: firstRun.repoPath,
    });
    writeFileSync(
      join(firstRun.repoPath, "branch-file.txt"),
      "branch change\n",
    );
    runChecked("git", ["add", "--all"], { cwd: firstRun.repoPath });
    runChecked(
      "git",
      ["commit", "-m", "feat: create execution branch commit"],
      {
        cwd: firstRun.repoPath,
      },
    );
    runChecked("git", ["push", "--set-upstream", "origin", executionBranch], {
      cwd: firstRun.repoPath,
    });

    const secondRun = await prepareTaskRepository({
      reposDir,
      repoName: "repo",
      repoUrl: seeded.remotePath,
      baseBranch: "main",
      executionBranch,
    });

    expect(secondRun.cloned).toBe(false);
    expect(secondRun.executionBranchMode).toBe("tracked_remote");
    expect(
      runChecked(
        "git",
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        {
          cwd: secondRun.repoPath,
        },
      ),
    ).toBe(`origin/${executionBranch}`);
  });
});

describe("git finalize outcomes", () => {
  it("returns no_changes when there are no file changes", async () => {
    const prepared = await createPreparedExecutionRepo();

    const result = await finalizeTaskChanges({
      repoPath: prepared.repoPath,
      executionBranch: prepared.executionBranch,
      baseBranch: "main",
      commitMessage: "chore: no-op",
      prTitle: "chore: no-op",
    });

    expect(result.outcome).toBe("no_changes");
  });

  it("returns success with commit sha and PR URL on successful flow", async () => {
    const prepared = await createPreparedExecutionRepo();
    const ghDir = createFakeGhScript({
      createOutput: "https://github.com/acme/repo/pull/123",
      viewOutput: "https://github.com/acme/repo/pull/123",
      failCreate: false,
    });
    const env = withPathPrefix(ghDir);

    writeFileSync(join(prepared.repoPath, "success.txt"), "success change\n");
    const result = await finalizeTaskChanges({
      repoPath: prepared.repoPath,
      executionBranch: prepared.executionBranch,
      baseBranch: "main",
      commitMessage: "feat: apply automated changes",
      prTitle: "feat: apply automated changes",
      prBody: "Automated update",
      env,
    });

    expect(result.outcome).toBe("success");
    expect(result.commitSha).toBeDefined();
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/123");
  });

  it("returns commit_failed when commit cannot be created", async () => {
    const prepared = await createPreparedExecutionRepo();
    writeFileSync(join(prepared.repoPath, "commit-fail.txt"), "change\n");

    const result = await finalizeTaskChanges({
      repoPath: prepared.repoPath,
      executionBranch: prepared.executionBranch,
      baseBranch: "main",
      commitMessage: "",
      prTitle: "chore: invalid",
    });

    expect(result.outcome).toBe("commit_failed");
  });

  it("returns push_failed when remote push fails", async () => {
    const prepared = await createPreparedExecutionRepo();
    writeFileSync(join(prepared.repoPath, "push-fail.txt"), "change\n");

    const result = await finalizeTaskChanges({
      repoPath: prepared.repoPath,
      executionBranch: prepared.executionBranch,
      baseBranch: "main",
      commitMessage: "feat: push failure path",
      prTitle: "feat: push failure path",
      remoteName: "missing-origin",
    });

    expect(result.outcome).toBe("push_failed");
  });

  it("returns pr_failed when gh pr create fails", async () => {
    const prepared = await createPreparedExecutionRepo();
    const ghDir = createFakeGhScript({
      createOutput: "",
      viewOutput: "",
      failCreate: true,
    });
    const env = withPathPrefix(ghDir);

    writeFileSync(join(prepared.repoPath, "pr-fail.txt"), "change\n");
    const result = await finalizeTaskChanges({
      repoPath: prepared.repoPath,
      executionBranch: prepared.executionBranch,
      baseBranch: "main",
      commitMessage: "feat: pr failure path",
      prTitle: "feat: pr failure path",
      env,
    });

    expect(result.outcome).toBe("pr_failed");
  });
});

interface SeededRepository {
  remotePath: string;
}

interface PreparedExecutionRepo {
  repoPath: string;
  executionBranch: string;
}

async function createPreparedExecutionRepo(): Promise<PreparedExecutionRepo> {
  const seeded = createSeededRemoteRepository();
  const reposDir = createTempDir("sidekick-m4-working-repos-");
  const executionBranch = "sidekick/task-finalize";
  const prepared = await prepareTaskRepository({
    reposDir,
    repoName: "repo",
    repoUrl: seeded.remotePath,
    baseBranch: "main",
    executionBranch,
  });

  runChecked("git", ["config", "user.email", "sidekick@example.com"], {
    cwd: prepared.repoPath,
  });
  runChecked("git", ["config", "user.name", "Sidekick"], {
    cwd: prepared.repoPath,
  });

  return {
    repoPath: prepared.repoPath,
    executionBranch,
  };
}

function createSeededRemoteRepository(): SeededRepository {
  const root = createTempDir("sidekick-m4-seed-");
  const remotePath = join(root, "repo.git");
  const seedPath = join(root, "seed");

  runChecked("git", ["init", "--bare", remotePath]);
  runChecked("git", ["init", "--initial-branch=main", seedPath]);
  runChecked("git", ["config", "user.email", "sidekick@example.com"], {
    cwd: seedPath,
  });
  runChecked("git", ["config", "user.name", "Sidekick"], {
    cwd: seedPath,
  });

  writeFileSync(join(seedPath, "README.md"), "seed\n");
  runChecked("git", ["add", "--all"], { cwd: seedPath });
  runChecked("git", ["commit", "-m", "chore: initial commit"], {
    cwd: seedPath,
  });
  runChecked("git", ["remote", "add", "origin", remotePath], { cwd: seedPath });
  runChecked("git", ["push", "--set-upstream", "origin", "main"], {
    cwd: seedPath,
  });

  return { remotePath };
}

function createFakeGhScript(input: {
  createOutput: string;
  viewOutput: string;
  failCreate: boolean;
}) {
  const binDir = createTempDir("sidekick-m4-gh-bin-");
  const ghPath = join(binDir, "gh");
  const script = `#!/usr/bin/env bash
set -eu
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  if [ "${input.failCreate ? "1" : "0"}" = "1" ]; then
    echo "mock create failure" >&2
    exit 1
  fi
  echo "${input.createOutput}"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo "${input.viewOutput}"
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`;
  writeFileSync(ghPath, script);
  chmodSync(ghPath, 0o755);
  return binDir;
}

function withPathPrefix(prefix: string) {
  return {
    ...process.env,
    PATH: `${prefix}:${process.env.PATH ?? ""}`,
  };
}

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runChecked(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        `Exit code: ${result.status}`,
        `stdout: ${result.stdout}`,
        `stderr: ${result.stderr}`,
      ].join("\n"),
    );
  }

  return result.stdout.trim();
}
