import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  commandSucceeded,
  formatCommandError,
  runCommand,
} from '../utils/command'

export type ExecutionBranchMode = 'tracked_remote' | 'created_from_base'

export interface EnsureRepoInput {
  reposDir: string
  repoName: string
  repoUrl: string
}

export interface EnsureRepoResult {
  repoPath: string
  cloned: boolean
}

export interface ResetRepoToBaseBranchInput {
  repoPath: string
  baseBranch: string
}

export interface PrepareExecutionBranchInput {
  repoPath: string
  baseBranch: string
  executionBranch: string
}

export interface PrepareTaskRepositoryInput {
  reposDir: string
  repoName: string
  repoUrl: string
  baseBranch: string
  executionBranch: string
}

export interface PrepareTaskRepositoryResult {
  repoPath: string
  cloned: boolean
  executionBranchMode: ExecutionBranchMode
}

export async function ensureRepo(
  input: EnsureRepoInput,
): Promise<EnsureRepoResult> {
  const repoPath = join(input.reposDir, input.repoName)
  const repoExists = await pathExists(repoPath)

  if (!repoExists) {
    await mkdir(input.reposDir, { recursive: true })
    await runGitCommand(
      ['clone', '--origin', 'origin', input.repoUrl, repoPath],
      `clone repository '${input.repoUrl}'`,
    )

    return { repoPath, cloned: true }
  }

  const gitDirExists = await pathExists(join(repoPath, '.git'))
  if (!gitDirExists) {
    throw new Error(
      `Repository path exists but is not a git repository: ${repoPath}`,
    )
  }

  await runGitInRepo(
    repoPath,
    ['remote', 'set-url', 'origin', input.repoUrl],
    `set remote url for '${repoPath}'`,
  )
  await runGitInRepo(
    repoPath,
    ['fetch', '--prune', 'origin'],
    `fetch latest refs for '${repoPath}'`,
  )

  return { repoPath, cloned: false }
}

export async function resetRepoToBaseBranch(
  input: ResetRepoToBaseBranchInput,
): Promise<void> {
  const baseRef = `origin/${input.baseBranch}`

  await runGitInRepo(
    input.repoPath,
    ['fetch', '--prune', 'origin'],
    `fetch latest refs for '${input.repoPath}'`,
  )
  await runGitInRepo(
    input.repoPath,
    ['checkout', '-B', input.baseBranch, baseRef],
    `checkout base branch '${input.baseBranch}'`,
  )
  await runGitInRepo(
    input.repoPath,
    ['reset', '--hard', baseRef],
    `reset base branch '${input.baseBranch}'`,
  )
  await runGitInRepo(
    input.repoPath,
    ['clean', '-fdx'],
    `clean working tree for '${input.repoPath}'`,
  )
}

export async function prepareExecutionBranch(
  input: PrepareExecutionBranchInput,
): Promise<ExecutionBranchMode> {
  const hasRemoteBranch = await remoteBranchExists(
    input.repoPath,
    input.executionBranch,
  )

  if (hasRemoteBranch) {
    const branchRef = `origin/${input.executionBranch}`
    await runGitInRepo(
      input.repoPath,
      ['checkout', '-B', input.executionBranch, branchRef],
      `checkout execution branch '${input.executionBranch}' from remote`,
    )
    await runGitInRepo(
      input.repoPath,
      [
        'branch',
        '--set-upstream-to',
        `origin/${input.executionBranch}`,
        input.executionBranch,
      ],
      `set upstream for '${input.executionBranch}'`,
    )

    return 'tracked_remote'
  }

  await runGitInRepo(
    input.repoPath,
    ['checkout', '-B', input.executionBranch, `origin/${input.baseBranch}`],
    `create execution branch '${input.executionBranch}' from base`,
  )

  const unsetUpstreamResult = await runCommand(
    'git',
    [
      '-C',
      input.repoPath,
      'branch',
      '--unset-upstream',
      input.executionBranch,
    ],
  )
  if (!commandSucceeded(unsetUpstreamResult)) {
    // Unset upstream is best-effort for newly created branches.
  }

  return 'created_from_base'
}

export async function prepareTaskRepository(
  input: PrepareTaskRepositoryInput,
): Promise<PrepareTaskRepositoryResult> {
  const ensuredRepo = await ensureRepo(input)
  await resetRepoToBaseBranch({
    repoPath: ensuredRepo.repoPath,
    baseBranch: input.baseBranch,
  })
  const executionBranchMode = await prepareExecutionBranch({
    repoPath: ensuredRepo.repoPath,
    baseBranch: input.baseBranch,
    executionBranch: input.executionBranch,
  })

  return {
    repoPath: ensuredRepo.repoPath,
    cloned: ensuredRepo.cloned,
    executionBranchMode,
  }
}

async function remoteBranchExists(repoPath: string, branchName: string) {
  const result = await runCommand(
    'git',
    ['-C', repoPath, 'ls-remote', '--heads', 'origin', `refs/heads/${branchName}`],
  )

  if (!commandSucceeded(result)) {
    throw new Error(
      formatCommandError(
        result,
        `check remote branch '${branchName}' for '${repoPath}'`,
      ),
    )
  }

  return result.stdout.trim().length > 0
}

async function runGitInRepo(repoPath: string, args: string[], purpose: string) {
  const result = await runCommand('git', ['-C', repoPath, ...args])
  if (!commandSucceeded(result)) {
    throw new Error(formatCommandError(result, purpose))
  }
}

async function runGitCommand(args: string[], purpose: string) {
  const result = await runCommand('git', args)
  if (!commandSucceeded(result)) {
    throw new Error(formatCommandError(result, purpose))
  }
}

async function pathExists(path: string) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}
