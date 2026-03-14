import { spawn } from 'node:child_process'

export interface RunCommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface RunCommandResult {
  command: string
  args: string[]
  cwd?: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  spawnError?: string
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let spawnError: string | undefined

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })

    child.on('error', (error: Error) => {
      spawnError = error.message
    })

    child.on('close', (exitCode, signal) => {
      resolve({
        command,
        args,
        cwd: options.cwd,
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        spawnError,
      })
    })
  })
}

export function commandSucceeded(result: RunCommandResult) {
  return result.exitCode === 0 && !result.spawnError
}

export function formatCommandError(result: RunCommandResult, purpose: string) {
  const stderr = result.stderr.trim()
  const stdout = result.stdout.trim()
  const output =
    stderr.length > 0
      ? stderr
      : stdout.length > 0
        ? stdout
        : result.spawnError ?? 'no output'
  const command = [result.command, ...result.args].join(' ')
  const code =
    result.exitCode !== null
      ? `exit code ${result.exitCode}`
      : result.signal
        ? `signal ${result.signal}`
        : 'unknown failure'

  return `${purpose} failed (${code}): ${command}; ${output}`
}
