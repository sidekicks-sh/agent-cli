import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'bun:test'

import {
  DEFAULT_BACKEND,
  createBackendAdapter,
  type BackendKind,
  type BackendLogEvent,
} from '../src/backends'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('backend defaults and selection', () => {
  it('keeps custom as default backend', () => {
    expect(DEFAULT_BACKEND).toBe('custom')
  })

  it('creates adapters for all supported backend kinds', () => {
    const kinds: BackendKind[] = ['custom', 'codex', 'claude', 'opencode']
    for (const kind of kinds) {
      const adapter = createBackendAdapter(kind)
      expect(adapter.kind).toBe(kind)
    }
  })
})

describe('custom backend adapter', () => {
  it('fails gracefully when required OpenRouter environment is missing', async () => {
    const repoPath = createTempDir('sidekick-backends-custom-missing-env-')
    const adapter = createBackendAdapter('custom')

    const result = await adapter.runTask(
      {
        repoPath,
        instructions: 'Create a summary',
      },
      { env: {} },
    )

    expect(result.success).toBe(false)
    expect(result.summary).toContain('missing model')
  })

  it('executes successfully in-process with mocked OpenRouter completion', async () => {
    const repoPath = createTempDir('sidekick-backends-custom-success-')
    const adapter = createBackendAdapter('custom')
    const originalFetch = globalThis.fetch
    const mockedFetch = Object.assign(
      (..._args: Parameters<typeof fetch>) =>
        (() => {
          void _args
          return Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [
                  {
                    finish_reason: 'stop',
                    message: {
                      role: 'assistant',
                      content: 'Custom backend completed task.',
                      tool_calls: [],
                    },
                  },
                ],
              }),
              {
                status: 200,
                headers: {
                  'content-type': 'application/json',
                },
              },
            ),
          )
        })(),
      {
        preconnect: originalFetch.preconnect,
      },
    ) as typeof fetch
    globalThis.fetch = mockedFetch

    try {
      const result = await adapter.runTask(
        {
          repoPath,
          instructions: 'Provide a one-line completion',
          systemPrompt: 'Be concise',
        },
        {
          env: {
            OPENROUTER_API_KEY: 'test-key',
            OPENROUTER_MODEL: 'openai/gpt-4.1-mini',
          },
        },
      )

      expect(result.success).toBe(true)
      expect(result.backend).toBe('custom')
      expect(result.output).toContain('Custom backend completed task.')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('external backend adapters', () => {
  it('runs codex, opencode and claude adapters with fake binaries', async () => {
    const repoPath = createTempDir('sidekick-backends-external-repo-')
    const binDir = createFakeBackendBinaries()
    const env = withPathPrefix(binDir)

    const adapters: BackendKind[] = ['codex', 'opencode', 'claude']
    for (const kind of adapters) {
      const adapter = createBackendAdapter(kind)
      const result = await adapter.runTask(
        {
          repoPath,
          instructions: 'Echo execution',
          systemPrompt: 'Follow instructions',
        },
        { env },
      )

      expect(result.success).toBe(true)
      expect(result.backend).toBe(kind)
      expect(result.output.length).toBeGreaterThan(0)
    }
  })

  it('surfaces backend startup failures without throwing', async () => {
    const repoPath = createTempDir('sidekick-backends-external-fail-')
    const adapter = createBackendAdapter('codex')

    const result = await adapter.runTask(
      {
        repoPath,
        instructions: 'Will fail due to missing binary',
      },
      {
        env: {
          ...process.env,
          PATH: '/tmp/sidekick-missing-bin',
        },
      },
    )

    expect(result.success).toBe(false)
    expect(result.summary).toContain('failed to start')
  })

  it('normalizes output logs in deterministic batches', async () => {
    const repoPath = createTempDir('sidekick-backends-log-batches-repo-')
    const binDir = createFakeBackendBinaries()
    const env = withPathPrefix(binDir)
    const events: BackendLogEvent[] = []
    const adapter = createBackendAdapter('codex', { logBatchSize: 2 })

    const result = await adapter.runTask(
      {
        repoPath,
        instructions: 'Batch log lines',
      },
      {
        env,
        onLog: (event) => {
          events.push(event)
        },
      },
    )

    expect(result.success).toBe(true)
    const stdoutEvents = events.filter((event) => event.stream === 'stdout')
    expect(stdoutEvents.length).toBeGreaterThan(0)
    expect(stdoutEvents[0].message.length).toBeGreaterThan(0)
  })
})

function createFakeBackendBinaries() {
  const binDir = createTempDir('sidekick-backends-bin-')

  writeExecutable(
    join(binDir, 'codex'),
    `#!/usr/bin/env bash
set -eu
if [ "$1" = "exec" ] && [ "$2" = "--yolo" ]; then
  input="$(cat)"
  printf 'codex line 1\\n'
  printf 'codex line 2\\n'
  printf 'codex prompt: %s\\n' "$input"
  exit 0
fi
echo "unexpected codex args: $*" >&2
exit 1
`,
  )

  writeExecutable(
    join(binDir, 'opencode'),
    `#!/usr/bin/env bash
set -eu
if [ "$1" = "run" ]; then
  shift
  printf 'opencode prompt: %s\\n' "$*"
  exit 0
fi
echo "unexpected opencode args: $*" >&2
exit 1
`,
  )

  writeExecutable(
    join(binDir, 'claude'),
    `#!/usr/bin/env bash
set -eu
input="$(cat)"
printf 'claude args: %s\\n' "$*"
printf 'claude input: %s\\n' "$input"
exit 0
`,
  )

  return binDir
}

function writeExecutable(path: string, content: string) {
  writeFileSync(path, content, 'utf8')
  chmodSync(path, 0o755)
}

function withPathPrefix(prefix: string) {
  return {
    ...process.env,
    PATH: `${prefix}:${process.env.PATH ?? ''}`,
  }
}

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
