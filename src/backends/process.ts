import { spawn } from 'node:child_process'

export interface ProcessRunOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  stdin?: string
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
}

export interface ProcessRunResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  spawnError?: string
}

export async function runProcess(
  command: string,
  args: string[],
  options: ProcessRunOptions,
): Promise<ProcessRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let spawnError: string | undefined

    const stdoutLines = createLineCollector(options.onStdoutLine)
    const stderrLines = createLineCollector(options.onStderrLine)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const asBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      stdoutChunks.push(asBuffer)
      stdoutLines.push(asBuffer.toString('utf8'))
    })

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const asBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      stderrChunks.push(asBuffer)
      stderrLines.push(asBuffer.toString('utf8'))
    })

    child.on('error', (error: Error) => {
      spawnError = error.message
    })

    if (typeof options.stdin === 'string') {
      child.stdin?.write(options.stdin)
    }
    child.stdin?.end()

    child.on('close', (exitCode, signal) => {
      stdoutLines.flush()
      stderrLines.flush()
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        spawnError,
      })
    })
  })
}

function createLineCollector(onLine?: (line: string) => void) {
  let buffer = ''

  return {
    push(chunk: string) {
      if (!onLine) {
        return
      }

      buffer += chunk
      while (true) {
        const newlineIndex = buffer.search(/\r?\n/)
        if (newlineIndex === -1) {
          return
        }

        const nextChar = buffer[newlineIndex]
        const separatorLength = nextChar === '\r' && buffer[newlineIndex + 1] === '\n' ? 2 : 1
        const line = buffer.slice(0, newlineIndex)
        onLine(line)
        buffer = buffer.slice(newlineIndex + separatorLength)
      }
    },
    flush() {
      if (!onLine) {
        return
      }

      if (buffer.length > 0) {
        onLine(buffer)
      }
      buffer = ''
    },
  }
}
