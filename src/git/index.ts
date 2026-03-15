import {
  commandSucceeded,
  formatCommandError,
  runCommand,
} from "../utils/command";

export const GIT_TASK_OUTCOMES = [
  "success",
  "no_changes",
  "commit_failed",
  "push_failed",
  "pr_failed",
  "gh_unavailable",
  "git_failed",
] as const;

export type GitTaskOutcome = (typeof GIT_TASK_OUTCOMES)[number];

export interface FinalizeTaskChangesInput {
  repoPath: string;
  executionBranch: string;
  baseBranch: string;
  commitMessage: string;
  prTitle: string;
  prBody?: string;
  remoteName?: string;
  env?: NodeJS.ProcessEnv;
}

export interface FinalizeTaskChangesResult {
  outcome: GitTaskOutcome;
  message: string;
  commitSha?: string;
  prUrl?: string;
}

interface PullRequestResult {
  outcome: "success" | "pr_failed" | "gh_unavailable";
  message: string;
  prUrl?: string;
}

export async function finalizeTaskChanges(
  input: FinalizeTaskChangesInput,
): Promise<FinalizeTaskChangesResult> {
  const remoteName = input.remoteName ?? "origin";

  try {
    const hasChanges = await hasWorkingTreeChanges(input.repoPath, input.env);
    if (!hasChanges) {
      return {
        outcome: "no_changes",
        message: "No tracked or untracked file changes detected",
      };
    }

    const addResult = await runGitInRepo(
      input.repoPath,
      ["add", "--all"],
      input.env,
    );
    if (!commandSucceeded(addResult)) {
      return {
        outcome: "commit_failed",
        message: formatCommandError(addResult, "stage changes"),
      };
    }

    const commitResult = await runGitInRepo(
      input.repoPath,
      ["commit", "-m", input.commitMessage],
      input.env,
    );
    if (!commandSucceeded(commitResult)) {
      if (indicatesNoChanges(commitResult)) {
        return {
          outcome: "no_changes",
          message: "Git reported no changes to commit",
        };
      }

      return {
        outcome: "commit_failed",
        message: formatCommandError(commitResult, "create commit"),
      };
    }

    const commitShaResult = await runGitInRepo(
      input.repoPath,
      ["rev-parse", "HEAD"],
      input.env,
    );
    if (!commandSucceeded(commitShaResult)) {
      return {
        outcome: "commit_failed",
        message: formatCommandError(commitShaResult, "read commit sha"),
      };
    }
    const commitSha = commitShaResult.stdout.trim();

    const pushResult = await runGitInRepo(
      input.repoPath,
      ["push", "--set-upstream", remoteName, input.executionBranch],
      input.env,
    );
    if (!commandSucceeded(pushResult)) {
      return {
        outcome: "push_failed",
        message: formatCommandError(
          pushResult,
          `push branch '${input.executionBranch}'`,
        ),
        commitSha,
      };
    }

    const pullRequestResult = await createPullRequest({
      repoPath: input.repoPath,
      executionBranch: input.executionBranch,
      baseBranch: input.baseBranch,
      prTitle: input.prTitle,
      prBody: input.prBody ?? "",
      env: input.env,
    });

    if (pullRequestResult.outcome !== "success") {
      return {
        outcome: pullRequestResult.outcome,
        message: pullRequestResult.message,
        commitSha,
        prUrl: pullRequestResult.prUrl,
      };
    }

    return {
      outcome: "success",
      message: pullRequestResult.message,
      commitSha,
      prUrl: pullRequestResult.prUrl,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: "git_failed",
      message: `Unhandled git operation failure: ${message}`,
    };
  }
}

export async function hasWorkingTreeChanges(
  repoPath: string,
  env?: NodeJS.ProcessEnv,
) {
  const result = await runGitInRepo(
    repoPath,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    env,
  );
  if (!commandSucceeded(result)) {
    throw new Error(formatCommandError(result, "inspect repository status"));
  }

  return result.stdout.trim().length > 0;
}

async function createPullRequest(input: {
  repoPath: string;
  executionBranch: string;
  baseBranch: string;
  prTitle: string;
  prBody: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PullRequestResult> {
  const createResult = await runCommand(
    "gh",
    [
      "pr",
      "create",
      "--base",
      input.baseBranch,
      "--head",
      input.executionBranch,
      "--title",
      input.prTitle,
      "--body",
      input.prBody,
    ],
    {
      cwd: input.repoPath,
      env: input.env,
    },
  );

  if (!commandSucceeded(createResult)) {
    if (isGhUnavailable(createResult)) {
      return {
        outcome: "gh_unavailable",
        message: formatCommandError(createResult, "create pull request"),
      };
    }

    if (indicatesExistingPullRequest(createResult)) {
      const existingPrUrl = await findExistingPullRequestUrl(
        input.repoPath,
        input.executionBranch,
        input.env,
      );
      return {
        outcome: "success",
        message: "Pull request already exists for execution branch",
        prUrl: existingPrUrl,
      };
    }

    return {
      outcome: "pr_failed",
      message: formatCommandError(createResult, "create pull request"),
    };
  }

  const prUrl =
    extractFirstUrl(createResult.stdout) ??
    extractFirstUrl(createResult.stderr);
  return {
    outcome: "success",
    message: "Changes pushed and pull request created",
    prUrl,
  };
}

async function findExistingPullRequestUrl(
  repoPath: string,
  executionBranch: string,
  env?: NodeJS.ProcessEnv,
) {
  const viewResult = await runCommand(
    "gh",
    ["pr", "view", executionBranch, "--json", "url", "--jq", ".url"],
    {
      cwd: repoPath,
      env,
    },
  );

  if (!commandSucceeded(viewResult)) {
    return undefined;
  }

  const prUrl = viewResult.stdout.trim();
  return prUrl.length > 0 ? prUrl : undefined;
}

async function runGitInRepo(
  repoPath: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) {
  return runCommand("git", ["-C", repoPath, ...args], { env });
}

function indicatesNoChanges(result: { stdout: string; stderr: string }) {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    output.includes("nothing to commit") ||
    output.includes("no changes added to commit")
  );
}

function indicatesExistingPullRequest(result: {
  stdout: string;
  stderr: string;
}) {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    output.includes("already exists") ||
    output.includes("a pull request for branch")
  );
}

function isGhUnavailable(result: { spawnError?: string }) {
  return (result.spawnError ?? "").toUpperCase().includes("ENOENT");
}

function extractFirstUrl(input: string) {
  const match = input.match(/https?:\/\/\S+/);
  return match ? match[0] : undefined;
}
