import { readdir, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

import type {
  Json,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from './types'

type ToolExecutor = (
  args: Record<string, Json>,
  context: ToolExecutionContext,
) => Promise<ToolExecutionResult>

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.next',
])

const MAX_FILE_SIZE_BYTES = 512_000

export interface ToolRegistry {
  definitions: ToolDefinition[]
  execute: ToolExecutor
}

export function createToolRegistry(input: { rootDir: string }) {
  const localTools = buildLocalTools(input.rootDir)
  const toolMap = new Map<string, ToolExecutor>(localTools.executors)
  const definitions = [...localTools.definitions]

  return {
    definitions,
    execute: async (args, context) => {
      const name = requiredString(args.__tool_name, '__tool_name')
      const executor = toolMap.get(name)
      if (!executor) {
        throw new Error(`Unknown tool: ${name}`)
      }

      const nextArgs = { ...args }
      delete nextArgs.__tool_name

      return executor(nextArgs, context)
    },
  } satisfies ToolRegistry
}

function buildLocalTools(rootDir: string) {
  const definitions: ToolDefinition[] = [
    {
      name: 'list_files',
      description: 'List files and directories inside the working directory.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          recursive: { type: 'boolean' },
          limit: { type: 'number' },
        },
      },
    },
    {
      name: 'read_file',
      description: 'Read a text file from the working directory.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'number' },
          end_line: { type: 'number' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description:
        'Write an entire text file inside the working directory, replacing existing contents.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'grep_files',
      description:
        'Search for a plain-text string in text files inside the working directory.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    },
    {
      name: 'run_command',
      description:
        'Run a shell command inside the working directory and capture stdout, stderr, and exit code.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          timeout_ms: { type: 'number' },
        },
        required: ['command'],
      },
    },
    {
      name: 'complete',
      description: 'Finish the task and return the final summary to the user.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          output: { type: 'string' },
        },
        required: ['summary'],
      },
    },
  ]

  const executors = new Map<string, ToolExecutor>([
    [
      'list_files',
      async (args) => {
        const target = resolveInsideRoot(rootDir, asString(args.path) ?? '.')
        const recursive = Boolean(args.recursive ?? false)
        const limit = clampLimit(asNumber(args.limit), 200)
        const entries = await collectEntries(rootDir, target, recursive, limit)
        return {
          ok: true,
          content: {
            root: rootDir,
            path: toRelative(rootDir, target),
            entries,
            truncated: entries.length >= limit,
          },
        }
      },
    ],
    [
      'read_file',
      async (args) => {
        const target = resolveInsideRoot(
          rootDir,
          requiredString(args.path, 'path'),
        )
        const fileInfo = await stat(target)
        if (fileInfo.size > MAX_FILE_SIZE_BYTES) {
          throw new Error(
            `File too large to read safely: ${toRelative(rootDir, target)}`,
          )
        }

        const contents = await readFile(target, 'utf8')
        const lines = contents.split('\n')
        const startLine = Math.max(
          1,
          Math.floor(asNumber(args.start_line) ?? 1),
        )
        const endLine = Math.min(
          lines.length,
          Math.floor(asNumber(args.end_line) ?? lines.length),
        )

        const excerpt = lines
          .slice(startLine - 1, endLine)
          .map((line, index) => `${startLine + index}: ${line}`)
          .join('\n')

        return {
          ok: true,
          content: {
            path: toRelative(rootDir, target),
            startLine,
            endLine,
            contents: excerpt,
          },
        }
      },
    ],
    [
      'write_file',
      async (args) => {
        const target = resolveInsideRoot(
          rootDir,
          requiredString(args.path, 'path'),
        )
        const content = expectString(args.content, 'content')
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, content, 'utf8')
        return {
          ok: true,
          content: {
            path: toRelative(rootDir, target),
            bytes: Buffer.byteLength(content, 'utf8'),
            lines: content === '' ? 0 : content.split('\n').length,
          },
        }
      },
    ],
    [
      'grep_files',
      async (args) => {
        const query = requiredString(args.query, 'query')
        const target = resolveInsideRoot(rootDir, asString(args.path) ?? '.')
        const limit = clampLimit(asNumber(args.limit), 100)
        const matches = await grepFiles(rootDir, target, query, limit)
        return {
          ok: true,
          content: {
            query,
            matches,
            truncated: matches.length >= limit,
          },
        }
      },
    ],
    [
      'run_command',
      async (args) => {
        const command = requiredString(args.command, 'command')
        const cwd = resolveInsideRoot(rootDir, asString(args.cwd) ?? '.')
        const timeoutMs = clampTimeout(asNumber(args.timeout_ms), 120_000)
        const result = await runCommand(command, cwd, timeoutMs)
        return {
          ok: result.exitCode === 0 && !result.timedOut,
          content: result,
        }
      },
    ],
    [
      'complete',
      (args) =>
        Promise.resolve({
          ok: true,
          terminal: true,
          content: {
            summary: requiredString(args.summary, 'summary'),
            output: asString(args.output) ?? '',
          },
        }),
    ],
  ])

  return {
    definitions,
    executors,
  }
}

function resolveInsideRoot(rootDir: string, targetPath: string) {
  const resolvedRoot = resolve(rootDir)
  const resolvedTarget = resolve(resolvedRoot, targetPath)
  const relativePath = relative(resolvedRoot, resolvedTarget)
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.includes(`${sep}..${sep}`)
  ) {
    throw new Error(`Path escapes working directory: ${targetPath}`)
  }

  return resolvedTarget
}

function toRelative(rootDir: string, target: string) {
  const output = relative(rootDir, target)
  return output === '' ? '.' : output
}

async function collectEntries(
  rootDir: string,
  target: string,
  recursive: boolean,
  limit: number,
) {
  const results: string[] = []

  async function walk(currentDir: string) {
    if (results.length >= limit) {
      return
    }

    const dirents = await readdir(currentDir, { withFileTypes: true })
    dirents.sort((left, right) => left.name.localeCompare(right.name))

    for (const dirent of dirents) {
      if (results.length >= limit) {
        return
      }

      if (SKIP_DIRS.has(dirent.name)) {
        continue
      }

      const fullPath = resolve(currentDir, dirent.name)
      const relPath = toRelative(rootDir, fullPath)
      results.push(dirent.isDirectory() ? `${relPath}/` : relPath)

      if (recursive && dirent.isDirectory()) {
        await walk(fullPath)
      }
    }
  }

  const targetStat = await stat(target)
  if (targetStat.isDirectory()) {
    await walk(target)
  } else {
    results.push(toRelative(rootDir, target))
  }

  return results
}

async function grepFiles(
  rootDir: string,
  target: string,
  query: string,
  limit: number,
) {
  const matches: Array<{ path: string; line: number; text: string }> = []

  async function walk(currentDir: string) {
    if (matches.length >= limit) {
      return
    }

    const dirents = await readdir(currentDir, { withFileTypes: true })
    dirents.sort((left, right) => left.name.localeCompare(right.name))

    for (const dirent of dirents) {
      if (matches.length >= limit) {
        return
      }

      if (SKIP_DIRS.has(dirent.name)) {
        continue
      }

      const fullPath = resolve(currentDir, dirent.name)

      if (dirent.isDirectory()) {
        await walk(fullPath)
        continue
      }

      const fileInfo = await stat(fullPath)
      if (fileInfo.size > MAX_FILE_SIZE_BYTES) {
        continue
      }

      const contents = await readFile(fullPath, 'utf8').catch(() => null)
      if (contents === null || contents.includes('\u0000')) {
        continue
      }

      const lines = contents.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(query)) {
          continue
        }

        matches.push({
          path: toRelative(rootDir, fullPath),
          line: index + 1,
          text: lines[index],
        })

        if (matches.length >= limit) {
          return
        }
      }
    }
  }

  const targetStat = await stat(target)
  if (targetStat.isDirectory()) {
    await walk(target)
  } else {
    const contents = await readFile(target, 'utf8')
    const lines = contents.split('\n')
    for (
      let index = 0;
      index < lines.length && matches.length < limit;
      index += 1
    ) {
      if (lines[index].includes(query)) {
        matches.push({
          path: toRelative(rootDir, target),
          line: index + 1,
          text: lines[index],
        })
      }
    }
  }

  return matches
}

async function runCommand(command: string, cwd: string, timeoutMs: number) {
  const proc = Bun.spawn({
    cmd: ['bash', '-lc', command],
    cwd,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)

  const exitCode = await proc.exited
  clearTimeout(timer)

  const stdout = await stdoutPromise
  const stderr = await stderrPromise
  const combined = joinAndTrimOutput(stdout, stderr, 16_000)

  return {
    command,
    cwd,
    exitCode,
    timedOut,
    stdout,
    stderr,
    output: combined.text,
    truncated: combined.truncated,
  }
}

function joinAndTrimOutput(stdout: string, stderr: string, maxChars: number) {
  const combined = [
    `[stdout]\n${stdout.trimEnd()}`,
    `[stderr]\n${stderr.trimEnd()}`,
  ]
    .filter(
      (chunk) => chunk.trim() !== '[stdout]' && chunk.trim() !== '[stderr]',
    )
    .join('\n\n')

  if (combined.length <= maxChars) {
    return {
      text: combined,
      truncated: false,
    }
  }

  return {
    text: `${combined.slice(0, maxChars)}\n\n[truncated]`,
    truncated: true,
  }
}

function requiredString(value: Json, name: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected ${name} to be a non-empty string`)
  }

  return value
}

function expectString(value: Json, name: string) {
  if (typeof value !== 'string') {
    throw new Error(`Expected ${name} to be a string`)
  }

  return value
}

function asString(value: Json) {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: Json) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clampLimit(value: number | undefined, fallback: number) {
  if (!value) {
    return fallback
  }

  return Math.max(1, Math.min(Math.floor(value), 500))
}

function clampTimeout(value: number | undefined, fallback: number) {
  if (!value) {
    return fallback
  }

  return Math.max(1_000, Math.min(Math.floor(value), 600_000))
}
