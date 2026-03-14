import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'bun:test'

import type { BackendAdapter } from '../src/backends'
import { runDaemonLoop, type DaemonLoopDependencies } from '../src/daemon'
import type {
  HeartbeatInput,
  RegisterSidekickInput,
  ReservedTask,
  SidekickRegistration,
  TaskLogInput,
  TaskStatusInput,
} from '../src/control-plane'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('daemon loop', () => {
  it('heartbeats and sleeps when no task is available', async () => {
    const fixture = createLoopFixture()
    let shouldStop = false

    const controlPlane = createFakeControlPlane({
      reserveTask: () => Promise.resolve(null),
    })

    const dependencies: DaemonLoopDependencies = {
      controlPlaneClient: controlPlane,
      createBackendAdapter: () => createNoopBackendAdapter(),
      sleep: () => {
        shouldStop = true
        return Promise.resolve()
      },
      now: () => 1_000,
      getHostname: () => 'test-host',
    }

    await runDaemonLoop(fixture.config, {
      shouldStop: () => shouldStop,
      dependencies,
      environment: {},
    })

    expect(controlPlane.heartbeatCalls.length).toBeGreaterThan(0)
    expect(controlPlane.registerCalls.length).toBe(1)
    expect(controlPlane.statusCalls.length).toBe(0)

    const lines = readStructuredLogLines(fixture.logFile)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some((line) => line.event === 'heartbeat')).toBe(true)
  })

  it('processes a task end-to-end and reports succeeded state', async () => {
    const fixture = createLoopFixture()
    let shouldStop = false
    let reserveCount = 0

    const task: ReservedTask = {
      taskId: 'task-1',
      runId: 'run-1',
      taskTitle: 'Apply changes',
      repoUrl: 'git@example.com:repo.git',
      repoName: 'repo',
      baseBranch: 'main',
      executionBranch: 'sidekick/task-1',
      instructions: 'Update README',
    }

    const controlPlane = createFakeControlPlane({
      reserveTask: () => {
        reserveCount += 1
        if (reserveCount === 1) {
          return Promise.resolve(task)
        }
        shouldStop = true
        return Promise.resolve(null)
      },
    })

    const dependencies: DaemonLoopDependencies = {
      controlPlaneClient: controlPlane,
      createBackendAdapter: () =>
        createBackendAdapterWithLogs([
          'line one',
          'line two',
          'line three',
        ]),
      prepareTaskRepository: () =>
        Promise.resolve({
          repoPath: join(fixture.rootDir, 'repo'),
          cloned: true,
          executionBranchMode: 'created_from_base',
        }),
      finalizeTaskChanges: () =>
        Promise.resolve({
          outcome: 'success',
          message: 'ok',
          commitSha: 'abc123',
          prUrl: 'https://example.com/pr/1',
        }),
      sleep: () => Promise.resolve(),
      now: (() => {
        let tick = 0
        return () => {
          tick += 1_000
          return tick
        }
      })(),
      getHostname: () => 'test-host',
    }

    await runDaemonLoop(fixture.config, {
      shouldStop: () => shouldStop,
      dependencies,
      environment: {},
    })

    expect(controlPlane.registerCalls.length).toBeGreaterThanOrEqual(2)
    expect(controlPlane.statusCalls.map((call) => call.status)).toContain('succeeded')
    expect(
      controlPlane.statusCalls.some((call) => call.message.includes('repo ready')),
    ).toBe(true)
    expect(controlPlane.taskLogCalls.length).toBeGreaterThan(0)

    const lines = readStructuredLogLines(fixture.logFile)
    expect(lines.some((line) => line.event === 'agent_output')).toBe(true)
    expect(lines.some((line) => line.status === 'working')).toBe(true)
  })

  it('keeps running when heartbeat network calls fail', async () => {
    const fixture = createLoopFixture()
    let shouldStop = false

    const controlPlane = createFakeControlPlane({
      reserveTask: () => Promise.resolve(null),
      sendHeartbeat: () => Promise.reject(new Error('network unreachable')),
    })

    const dependencies: DaemonLoopDependencies = {
      controlPlaneClient: controlPlane,
      createBackendAdapter: () => createNoopBackendAdapter(),
      sleep: () => {
        shouldStop = true
        return Promise.resolve()
      },
      now: () => 1_000,
      getHostname: () => 'test-host',
    }

    await runDaemonLoop(fixture.config, {
      shouldStop: () => shouldStop,
      dependencies,
      environment: {},
    })

    expect(controlPlane.heartbeatCalls.length).toBeGreaterThan(0)
    const lines = readStructuredLogLines(fixture.logFile)
    expect(
      lines.some(
        (line) =>
          line.event === 'heartbeat' &&
          line.level === 'warn' &&
          line.message.includes('heartbeat failed'),
      ),
    ).toBe(true)
  })

  it('contains backend crashes as task failures and continues loop', async () => {
    const fixture = createLoopFixture()
    let shouldStop = false
    let reserveCount = 0

    const controlPlane = createFakeControlPlane({
      reserveTask: () => {
        reserveCount += 1
        if (reserveCount === 1) {
          return Promise.resolve(createReservedTask())
        }
        shouldStop = true
        return Promise.resolve(null)
      },
    })

    const dependencies: DaemonLoopDependencies = {
      controlPlaneClient: controlPlane,
      createBackendAdapter: () => ({
        kind: 'custom',
        runTask: () => Promise.reject(new Error('backend exploded')),
      }),
      prepareTaskRepository: () =>
        Promise.resolve({
          repoPath: join(fixture.rootDir, 'repo'),
          cloned: true,
          executionBranchMode: 'created_from_base',
        }),
      sleep: () => Promise.resolve(),
      now: () => 1_000,
      getHostname: () => 'test-host',
    }

    await runDaemonLoop(fixture.config, {
      shouldStop: () => shouldStop,
      dependencies,
      environment: {},
    })

    expect(controlPlane.statusCalls.map((call) => call.status)).toContain('failed')
    expect(
      controlPlane.statusCalls.some((call) =>
        call.message.includes('task processing crashed: backend exploded'),
      ),
    ).toBe(true)
    const lines = readStructuredLogLines(fixture.logFile)
    expect(
      lines.some(
        (line) =>
          line.event === 'task' &&
          line.level === 'error' &&
          line.message.includes('task processing crashed: backend exploded'),
      ),
    ).toBe(true)
  })

  it('shuts down gracefully after finishing an active task', async () => {
    const fixture = createLoopFixture()
    let shouldStop = false
    const task = createReservedTask()
    let reserveCount = 0
    let releaseBackend: (() => void) | undefined
    let backendStartedResolve: (() => void) | undefined
    const backendStarted = new Promise<void>((resolve) => {
      backendStartedResolve = resolve
    })

    const controlPlane = createFakeControlPlane({
      reserveTask: () => {
        reserveCount += 1
        if (reserveCount === 1) {
          return Promise.resolve(task)
        }
        return Promise.resolve(null)
      },
    })

    const dependencies: DaemonLoopDependencies = {
      controlPlaneClient: controlPlane,
      createBackendAdapter: () => ({
        kind: 'custom',
        runTask: () =>
          new Promise((resolve) => {
            shouldStop = true
            backendStartedResolve?.()
            releaseBackend = () => {
              resolve({
                backend: 'custom',
                success: true,
                summary: 'done',
                output: 'ok',
                exitCode: 0,
              })
            }
          }),
      }),
      prepareTaskRepository: () =>
        Promise.resolve({
          repoPath: join(fixture.rootDir, 'repo'),
          cloned: true,
          executionBranchMode: 'created_from_base',
        }),
      finalizeTaskChanges: () =>
        Promise.resolve({
          outcome: 'success',
          message: 'ok',
          commitSha: 'abc123',
          prUrl: 'https://example.com/pr/1',
        }),
      sleep: () => Promise.resolve(),
      now: (() => {
        let tick = 0
        return () => {
          tick += 1_000
          return tick
        }
      })(),
      getHostname: () => 'test-host',
    }

    const loopPromise = runDaemonLoop(fixture.config, {
      shouldStop: () => shouldStop,
      dependencies,
      environment: {},
    })
    await backendStarted
    releaseBackend?.()
    await loopPromise

    expect(controlPlane.statusCalls.map((call) => call.status)).toContain('succeeded')
    expect(controlPlane.statusCalls.some((call) => call.status === 'failed')).toBe(
      false,
    )
    const lines = readStructuredLogLines(fixture.logFile)
    expect(lines.some((line) => line.event === 'runtime')).toBe(true)
    expect(lines.some((line) => line.message.includes('shutdown requested'))).toBe(
      true,
    )
  })
})

interface LoopFixture {
  rootDir: string
  logFile: string
  config: {
    controlPlaneUrl: string
    apiToken: string
    sidekickId: string
    reposDir: string
    pollIntervalSeconds: number
    agent: 'custom'
    pidFile: string
    logFile: string
    logBatchSize: number
  }
}

function createLoopFixture(): LoopFixture {
  const rootDir = createTempDir('sidekick-daemon-loop-')
  const logFile = join(rootDir, 'sidekick.log')
  return {
    rootDir,
    logFile,
    config: {
      controlPlaneUrl: 'https://example.com/api',
      apiToken: 'token',
      sidekickId: 'sidekick-test',
      reposDir: join(rootDir, 'repos'),
      pollIntervalSeconds: 1,
      agent: 'custom',
      pidFile: join(rootDir, 'sidekick.pid'),
      logFile,
      logBatchSize: 2,
    },
  }
}

function createNoopBackendAdapter(): BackendAdapter {
  return {
    kind: 'custom',
    runTask: () =>
      Promise.resolve({
        backend: 'custom',
        success: true,
        summary: 'noop',
        output: '',
        exitCode: 0,
      }),
  }
}

function createBackendAdapterWithLogs(lines: string[]): BackendAdapter {
  return {
    kind: 'custom',
    runTask: (_input, context) => {
      for (const line of lines) {
        context?.onLog?.({
          backend: 'custom',
          stream: 'stdout',
          message: line,
          timestamp: new Date().toISOString(),
        })
      }

      return Promise.resolve({
        backend: 'custom',
        success: true,
        summary: 'done',
        output: 'ok',
        exitCode: 0,
      })
    },
  }
}

function createFakeControlPlane(input: {
  reserveTask: () => Promise<ReservedTask | null>
  registerSidekick?: (
    payload: RegisterSidekickInput,
  ) => Promise<SidekickRegistration>
  sendHeartbeat?: (payload: HeartbeatInput) => Promise<void>
  sendTaskStatus?: (payload: TaskStatusInput) => Promise<void>
  sendTaskLog?: (payload: TaskLogInput) => Promise<void>
}) {
  const registerCalls: RegisterSidekickInput[] = []
  const heartbeatCalls: HeartbeatInput[] = []
  const statusCalls: TaskStatusInput[] = []
  const taskLogCalls: TaskLogInput[] = []
  const registerResponse: SidekickRegistration = {
    name: 'test-sidekick',
    purpose: 'test',
    prompt: 'you are testing',
  }

  return {
    registerCalls,
    heartbeatCalls,
    statusCalls,
    taskLogCalls,
    registerSidekick(inputPayload: RegisterSidekickInput) {
      registerCalls.push(inputPayload)
      if (input.registerSidekick) {
        return input.registerSidekick(inputPayload)
      }
      return Promise.resolve(registerResponse)
    },
    reserveTask() {
      return input.reserveTask()
    },
    sendHeartbeat(inputPayload: HeartbeatInput) {
      heartbeatCalls.push(inputPayload)
      if (input.sendHeartbeat) {
        return input.sendHeartbeat(inputPayload)
      }
      return Promise.resolve()
    },
    sendTaskStatus(inputPayload: TaskStatusInput) {
      statusCalls.push(inputPayload)
      if (input.sendTaskStatus) {
        return input.sendTaskStatus(inputPayload)
      }
      return Promise.resolve()
    },
    sendTaskLog(inputPayload: TaskLogInput) {
      taskLogCalls.push(inputPayload)
      if (input.sendTaskLog) {
        return input.sendTaskLog(inputPayload)
      }
      return Promise.resolve()
    },
  }
}

function readStructuredLogLines(path: string) {
  const raw = readFileSync(path, 'utf8').trim()
  if (raw.length === 0) {
    return []
  }

  return raw
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          event: string
          status: string
          level: 'info' | 'warn' | 'error'
          message: string
        },
    )
}

function createReservedTask(): ReservedTask {
  return {
    taskId: 'task-1',
    runId: 'run-1',
    taskTitle: 'Apply changes',
    repoUrl: 'git@example.com:repo.git',
    repoName: 'repo',
    baseBranch: 'main',
    executionBranch: 'sidekick/task-1',
    instructions: 'Update README',
  }
}

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
