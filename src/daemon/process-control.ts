import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { SidekickConfig } from '../config'
import { runDaemonLoop } from './loop'

const STOP_WAIT_MS = 10_000
const STOP_POLL_MS = 100

let lifecycleHooksInstalled = false

export interface DaemonStatus {
  running: boolean
  stalePidFile: boolean
  pidFile: string
  logFile: string
  pid?: number
}

export interface DaemonStopResult {
  stopped: boolean
  message: string
}

interface ForegroundScaffoldOptions {
  mirrorLogsToStderr?: boolean
}

export async function runForegroundScaffold(
  config: SidekickConfig,
  options: ForegroundScaffoldOptions = {},
) {
  await ensureSingleInstance(config.pidFile)
  await mkdir(dirname(config.logFile), { recursive: true })

  await writeRuntimeLog(
    config.logFile,
    `sidekick started pid=${process.pid} backend=${config.agent}`,
  )

  let shouldStop = false
  const signalWatcher = waitForTerminationSignal().then((signal) => {
    shouldStop = true
    return signal
  })

  try {
    await runDaemonLoop(config, {
      shouldStop: () => shouldStop,
      environment: process.env,
      mirrorLogsToStderr: options.mirrorLogsToStderr ?? false,
    })
  } catch (error) {
    await writeRuntimeLog(
      config.logFile,
      `sidekick daemon loop crashed: ${error instanceof Error ? error.message : String(error)}`,
    )
    throw error
  }

  const signal = await signalWatcher
  await writeRuntimeLog(config.logFile, `sidekick received ${signal}; exiting`)
}

export async function startDetached(
  config: SidekickConfig,
  argv: string[],
  execPath: string,
) {
  const status = await getDaemonStatus(config)
  if (status.running) {
    return { alreadyRunning: true, pid: status.pid! }
  }

  await mkdir(dirname(config.logFile), { recursive: true })
  await mkdir(dirname(config.pidFile), { recursive: true })
  if (status.stalePidFile) {
    await removePidFile(config.pidFile)
  }

  const invocation = buildSelfInvocation(argv, execPath)
  const childArgs = [...invocation.baseArgs, 'start', '--no-detach']

  const logFd = openSync(config.logFile, 'a')
  const child = spawn(invocation.command, childArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: process.cwd(),
    env: {
      ...process.env,
      SIDEKICK_LOG_FILE: config.logFile,
      SIDEKICK_PID_FILE: config.pidFile,
      SIDEKICK_AGENT: config.agent,
    },
  })
  child.unref()
  closeSync(logFd)

  if (!child.pid) {
    throw new Error('Failed to start detached daemon process')
  }

  await writePidFile(config.pidFile, child.pid)
  await sleep(250)

  if (!isProcessAlive(child.pid)) {
    await removePidFile(config.pidFile)
    throw new Error(`Detached process exited immediately (pid ${child.pid})`)
  }

  return { alreadyRunning: false, pid: child.pid }
}

export async function getDaemonStatus(
  config: Pick<SidekickConfig, 'pidFile' | 'logFile'>,
): Promise<DaemonStatus> {
  const pid = await readPidFile(config.pidFile)
  if (pid === null) {
    return {
      running: false,
      stalePidFile: false,
      pidFile: config.pidFile,
      logFile: config.logFile,
    }
  }

  if (!isProcessAlive(pid)) {
    return {
      running: false,
      stalePidFile: true,
      pidFile: config.pidFile,
      logFile: config.logFile,
      pid,
    }
  }

  return {
    running: true,
    stalePidFile: false,
    pidFile: config.pidFile,
    logFile: config.logFile,
    pid,
  }
}

export async function stopDaemon(
  config: Pick<SidekickConfig, 'pidFile' | 'logFile'>,
): Promise<DaemonStopResult> {
  const status = await getDaemonStatus(config)
  if (!status.running) {
    if (status.stalePidFile) {
      await removePidFile(config.pidFile)
      return { stopped: true, message: 'sidekick was not running (removed stale pid file)' }
    }

    return { stopped: true, message: 'sidekick is not running' }
  }

  const pid = status.pid!
  process.kill(pid, 'SIGTERM')

  const stoppedAfterTerm = await waitForProcessExit(pid, STOP_WAIT_MS)
  if (stoppedAfterTerm) {
    await removePidFile(config.pidFile)
    return { stopped: true, message: `sidekick stopped (pid ${pid})` }
  }

  process.kill(pid, 'SIGKILL')
  const stoppedAfterKill = await waitForProcessExit(pid, 2_000)
  if (stoppedAfterKill) {
    await removePidFile(config.pidFile)
    return { stopped: true, message: `sidekick force-stopped (pid ${pid})` }
  }

  return {
    stopped: false,
    message: `sidekick did not stop in time (pid ${pid})`,
  }
}

async function ensureSingleInstance(pidFile: string) {
  const existingPid = await readPidFile(pidFile)
  if (existingPid !== null && isProcessAlive(existingPid) && existingPid !== process.pid) {
    throw new Error(`sidekick already running (pid ${existingPid})`)
  }

  if (existingPid !== null && !isProcessAlive(existingPid)) {
    await removePidFile(pidFile)
  }

  await writePidFile(pidFile, process.pid)
  installLifecycleHooks(pidFile)
}

function installLifecycleHooks(pidFile: string) {
  if (lifecycleHooksInstalled) {
    return
  }

  lifecycleHooksInstalled = true
  const cleanup = () => cleanupPidFileSync(pidFile)

  process.on('exit', cleanup)
  process.on('SIGINT', () => {
    cleanup()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(0)
  })
}

function cleanupPidFileSync(pidFile: string) {
  try {
    const raw = readFileSync(pidFile, 'utf8').trim()
    if (!/^\d+$/.test(raw)) {
      rmSync(pidFile, { force: true })
      return
    }

    if (Number.parseInt(raw, 10) === process.pid) {
      rmSync(pidFile, { force: true })
    }
  } catch {
    // Best effort.
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readPidFile(pidFile: string) {
  try {
    const raw = (await readFile(pidFile, 'utf8')).trim()
    if (!/^\d+$/.test(raw)) {
      return null
    }
    return Number.parseInt(raw, 10)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function writePidFile(pidFile: string, pid: number) {
  await mkdir(dirname(pidFile), { recursive: true })
  await writeFile(pidFile, `${pid}\n`, 'utf8')
}

async function removePidFile(pidFile: string) {
  await rm(pidFile, { force: true })
}

async function waitForProcessExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true
    }
    await sleep(STOP_POLL_MS)
  }

  return !isProcessAlive(pid)
}

function waitForTerminationSignal() {
  return new Promise<NodeJS.Signals>((resolve) => {
    const onSigint = () => {
      process.off('SIGTERM', onSigterm)
      resolve('SIGINT')
    }
    const onSigterm = () => {
      process.off('SIGINT', onSigint)
      resolve('SIGTERM')
    }

    process.once('SIGINT', onSigint)
    process.once('SIGTERM', onSigterm)
  })
}

async function writeRuntimeLog(logFile: string, message: string) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  await appendFile(logFile, line, 'utf8')
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

function buildSelfInvocation(argv: string[], execPath: string) {
  const executable = execPath || argv[0]
  const second = argv[1]
  const third = argv[2]

  if (executable.includes('bun')) {
    if (second === 'run') {
      return third
        ? { command: executable, baseArgs: ['run', third] }
        : { command: executable, baseArgs: ['run'] }
    }

    if (second && second.endsWith('.ts')) {
      return { command: executable, baseArgs: [second] }
    }
  }

  return { command: executable, baseArgs: [] }
}
