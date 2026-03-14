import { hostname as getOsHostname } from 'node:os'

import { createBackendAdapter } from '../backends'
import type {
  BackendAdapter,
  BackendFactoryOptions,
  BackendLogEvent,
  BackendRunContext,
  BackendTaskInput,
  BackendTaskResult,
} from '../backends'
import type { SidekickConfig } from '../config'
import { ControlPlaneClient } from '../control-plane'
import type {
  HeartbeatInput,
  RegisterSidekickInput,
  ReservedTask,
  SidekickRegistration,
  SidekickRuntimeStatus,
  TaskLogInput,
  TaskStatusInput,
} from '../control-plane'
import { finalizeTaskChanges } from '../git'
import { StructuredLogger } from '../logging'
import { prepareTaskRepository } from '../repo'

interface ControlPlanePort {
  registerSidekick(input: RegisterSidekickInput): Promise<SidekickRegistration>
  reserveTask(): Promise<ReservedTask | null>
  sendHeartbeat(input: HeartbeatInput): Promise<void>
  sendTaskStatus(input: TaskStatusInput): Promise<void>
  sendTaskLog(input: TaskLogInput): Promise<void>
}

export interface DaemonLoopDependencies {
  controlPlaneClient?: ControlPlanePort
  createBackendAdapter?: (
    kind: SidekickConfig['agent'],
    options?: BackendFactoryOptions,
  ) => BackendAdapter
  prepareTaskRepository?: typeof prepareTaskRepository
  finalizeTaskChanges?: typeof finalizeTaskChanges
  sleep?: (ms: number) => Promise<void>
  getHostname?: () => string
  now?: () => number
}

export interface RunDaemonLoopOptions {
  shouldStop?: () => boolean
  dependencies?: DaemonLoopDependencies
  environment?: NodeJS.ProcessEnv
  mirrorLogsToStderr?: boolean
}

interface RuntimeState {
  status: SidekickRuntimeStatus
  sidekickName: string
  sidekickPrompt: string
  currentTaskId?: string
  currentRunId?: string
}

interface RuntimeCounters {
  startedAtMs: number
  completed: number
  failed: number
}

export async function runDaemonLoop(
  config: SidekickConfig,
  options: RunDaemonLoopOptions = {},
) {
  const dependencies = options.dependencies ?? {}
  const shouldStop = options.shouldStop ?? (() => false)
  const sleep = dependencies.sleep ?? defaultSleep
  const getHostname = dependencies.getHostname ?? getOsHostname
  const now = dependencies.now ?? Date.now
  const env = options.environment ?? process.env

  const controlPlaneClient =
    dependencies.controlPlaneClient ??
    new ControlPlaneClient({
      baseUrl: config.controlPlaneUrl,
      apiToken: config.apiToken,
    })

  const backendAdapter =
    dependencies.createBackendAdapter?.(config.agent, {
      logBatchSize: config.logBatchSize,
    }) ??
    createBackendAdapter(config.agent, {
      logBatchSize: config.logBatchSize,
    })

  const runPrepareTaskRepository =
    dependencies.prepareTaskRepository ?? prepareTaskRepository
  const runFinalizeTaskChanges =
    dependencies.finalizeTaskChanges ?? finalizeTaskChanges

  const state: RuntimeState = {
    status: 'booting',
    sidekickName: 'sidekick',
    sidekickPrompt: '',
  }
  const counters: RuntimeCounters = {
    startedAtMs: now(),
    completed: 0,
    failed: 0,
  }

  const logger = new StructuredLogger({
    logFile: config.logFile,
    logBatchSize: config.logBatchSize,
    mirrorToStderr: options.mirrorLogsToStderr ?? false,
    getContext: () => ({
      sidekickId: config.sidekickId,
      sidekickName: state.sidekickName,
      status: state.status,
      taskId: state.currentTaskId,
      runId: state.currentRunId,
    }),
    onTaskLogBatch: async (taskId, runId, message) => {
      await safeTaskLog(controlPlaneClient, {
        id: taskId,
        runId,
        message,
      })
    },
  })

  await logger.info(
    'runtime',
    `daemon booting backend=${config.agent} sidekick_id=${config.sidekickId}`,
  )
  await refreshRegistration(
    controlPlaneClient,
    logger,
    state,
    config.agent,
    getHostname(),
  )

  state.status = 'idle'
  await logger.info('runtime', 'state transition booting -> idle')

  while (!shouldStop()) {
    await sendHeartbeat(controlPlaneClient, logger, state, counters, now, config.agent)

    let reservedTask: ReservedTask | null = null
    try {
      reservedTask = await controlPlaneClient.reserveTask()
    } catch (error) {
      await logger.warn(
        'reserve_task',
        `reserve task failed: ${formatErrorMessage(error)}`,
      )
    }

    if (!reservedTask) {
      await logger.info(
        'runtime',
        `no task available; sleeping ${config.pollIntervalSeconds}s`,
      )
      await sleep(config.pollIntervalSeconds * 1_000)
      continue
    }

    try {
      await processTask({
        task: reservedTask,
        config,
        state,
        counters,
        logger,
        controlPlaneClient,
        backendAdapter,
        prepareTaskRepositoryFn: runPrepareTaskRepository,
        finalizeTaskChangesFn: runFinalizeTaskChanges,
        env,
      })
    } catch (error) {
      const message = `task processing crashed: ${formatErrorMessage(error)}`
      await failTask(controlPlaneClient, logger, counters, reservedTask, message)
      await endTask(logger, state)
    }
  }

  await logger.info('runtime', 'shutdown requested')
  await logger.flushTaskLogs()
}

async function processTask(input: {
  task: ReservedTask
  config: SidekickConfig
  state: RuntimeState
  counters: RuntimeCounters
  logger: StructuredLogger
  controlPlaneClient: ControlPlanePort
  backendAdapter: BackendAdapter
  prepareTaskRepositoryFn: typeof prepareTaskRepository
  finalizeTaskChangesFn: typeof finalizeTaskChanges
  env: NodeJS.ProcessEnv
}) {
  const {
    task,
    config,
    state,
    counters,
    logger,
    controlPlaneClient,
    backendAdapter,
    prepareTaskRepositoryFn,
    finalizeTaskChangesFn,
    env,
  } = input

  state.status = 'working'
  state.currentTaskId = task.taskId
  state.currentRunId = task.runId

  await logger.info('task', `processing task id=${task.taskId} run_id=${task.runId}`)
  await safeTaskStatus(controlPlaneClient, {
    id: task.taskId,
    runId: task.runId,
    status: 'running',
    message: 'started',
  })

  await refreshRegistration(
    controlPlaneClient,
    logger,
    state,
    config.agent,
    getOsHostname(),
  )

  let repoPath = ''
  try {
    const repoResult = await prepareTaskRepositoryFn({
      reposDir: config.reposDir,
      repoName: task.repoName,
      repoUrl: task.repoUrl,
      baseBranch: task.baseBranch,
      executionBranch: task.executionBranch,
    })
    repoPath = repoResult.repoPath

    await logger.info(
      'repo',
      `repository ready path=${repoPath} cloned=${repoResult.cloned} execution_branch_mode=${repoResult.executionBranchMode}`,
    )
    await safeTaskStatus(controlPlaneClient, {
      id: task.taskId,
      runId: task.runId,
      status: 'running',
      message: 'repo ready',
    })
  } catch (error) {
    await failTask(
      controlPlaneClient,
      logger,
      counters,
      task,
      `repo preparation failed: ${formatErrorMessage(error)}`,
    )
    await endTask(logger, state)
    return
  }

  const backendContext: BackendRunContext = {
    env,
    onLog: (event: BackendLogEvent) => {
      void logger.log(
        event.stream === 'stderr' ? 'warn' : 'info',
        'agent_output',
        `[${event.backend}/${event.stream}] ${event.message}`,
      )
    },
  }

  const backendInput: BackendTaskInput = {
    repoPath,
    instructions: task.instructions,
    systemPrompt: state.sidekickPrompt,
  }

  const backendResult: BackendTaskResult = await backendAdapter.runTask(
    backendInput,
    backendContext,
  )
  await logger.flushTaskLogs()

  if (!backendResult.success) {
    await failTask(
      controlPlaneClient,
      logger,
      counters,
      task,
      `${backendResult.backend} failed: ${backendResult.error ?? backendResult.summary}`,
    )
    await endTask(logger, state)
    return
  }

  await logger.info(
    'task',
    `backend complete backend=${backendResult.backend} summary=${backendResult.summary}`,
  )
  await safeTaskStatus(controlPlaneClient, {
    id: task.taskId,
    runId: task.runId,
    status: 'running',
    message: 'backend complete',
  })

  const gitResult = await finalizeTaskChangesFn({
    repoPath,
    executionBranch: task.executionBranch,
    baseBranch: task.baseBranch,
    commitMessage: task.taskTitle,
    prTitle: task.taskTitle,
    prBody: task.instructions,
    env,
  })

  switch (gitResult.outcome) {
    case 'success': {
      counters.completed += 1
      await logger.info(
        'task',
        `task succeeded commit=${gitResult.commitSha ?? 'unknown'} pr=${gitResult.prUrl ?? 'n/a'}`,
      )
      await safeTaskStatus(controlPlaneClient, {
        id: task.taskId,
        runId: task.runId,
        status: 'succeeded',
        message: gitResult.prUrl ? `PR opened: ${gitResult.prUrl}` : 'PR opened',
      })
      break
    }
    case 'no_changes': {
      counters.completed += 1
      await logger.info('task', 'task succeeded with no changes')
      await safeTaskStatus(controlPlaneClient, {
        id: task.taskId,
        runId: task.runId,
        status: 'succeeded',
        message: 'no changes',
      })
      break
    }
    default: {
      counters.failed += 1
      await logger.error(
        'task',
        `task failed during git stage outcome=${gitResult.outcome} message=${gitResult.message}`,
      )
      await safeTaskStatus(controlPlaneClient, {
        id: task.taskId,
        runId: task.runId,
        status: 'failed',
        message: gitResult.outcome,
      })
      break
    }
  }

  await endTask(logger, state)
}

async function endTask(logger: StructuredLogger, state: RuntimeState) {
  await logger.flushTaskLogs()
  state.status = 'idle'
  state.currentTaskId = undefined
  state.currentRunId = undefined
}

async function failTask(
  controlPlaneClient: ControlPlanePort,
  logger: StructuredLogger,
  counters: RuntimeCounters,
  task: ReservedTask,
  message: string,
) {
  counters.failed += 1
  await logger.error('task', message)
  await safeTaskStatus(controlPlaneClient, {
    id: task.taskId,
    runId: task.runId,
    status: 'failed',
    message,
  })
}

async function refreshRegistration(
  controlPlaneClient: ControlPlanePort,
  logger: StructuredLogger,
  state: RuntimeState,
  agent: SidekickConfig['agent'],
  hostname: string,
) {
  try {
    const registration = await controlPlaneClient.registerSidekick({
      agent,
      hostname,
      status: state.status,
    })
    state.sidekickName = registration.name
    state.sidekickPrompt = registration.prompt
    await logger.info(
      'registration',
      `registered sidekick name=${registration.name} purpose=${registration.purpose}`,
    )
  } catch (error) {
    await logger.warn(
      'registration',
      `registration refresh failed: ${formatErrorMessage(error)}`,
    )
  }
}

async function sendHeartbeat(
  controlPlaneClient: ControlPlanePort,
  logger: StructuredLogger,
  state: RuntimeState,
  counters: RuntimeCounters,
  now: () => number,
  agent: SidekickConfig['agent'],
) {
  const uptimeSeconds = Math.floor((now() - counters.startedAtMs) / 1_000)
  await logger.info(
    'heartbeat',
    `uptime=${formatUptime(uptimeSeconds)} completed=${counters.completed} failed=${counters.failed} agent=${agent}`,
  )

  try {
    await controlPlaneClient.sendHeartbeat({
      status: state.status,
    })
  } catch (error) {
    await logger.warn(
      'heartbeat',
      `heartbeat failed: ${formatErrorMessage(error)}`,
    )
  }
}

async function safeTaskStatus(
  controlPlaneClient: ControlPlanePort,
  input: TaskStatusInput,
) {
  try {
    await controlPlaneClient.sendTaskStatus(input)
  } catch {
    // Status updates should never crash task processing.
  }
}

async function safeTaskLog(
  controlPlaneClient: ControlPlanePort,
  input: TaskLogInput,
) {
  try {
    await controlPlaneClient.sendTaskLog(input)
  } catch {
    // Task log forwarding is best-effort.
  }
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

function formatUptime(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return `${hours.toString().padStart(2, '0')}h${minutes.toString().padStart(2, '0')}m${seconds.toString().padStart(2, '0')}s`
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
