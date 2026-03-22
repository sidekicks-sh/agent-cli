import { hostname as getOsHostname } from "node:os";

import { createBackendAdapter } from "../backends";
import type {
  BackendAdapter,
  BackendFactoryOptions,
  BackendLogEvent,
  BackendRunContext,
  BackendTaskInput,
  BackendTaskResult,
} from "../backends";
import type { SidekickConfig } from "../config";
import {
  ControlPlaneClient,
  createDefaultSidekickSteps,
} from "../control-plane";
import type {
  HeartbeatInput,
  RegisterSidekickInput,
  ReservedTask,
  SidekickRegistration,
  SidekickRuntimeStatus,
  SidekickStep,
  SidekickStepDecision,
  TaskArtifactInput,
  TaskLogInput,
  TaskStatusInput,
} from "../control-plane";
import { finalizeTaskChanges } from "../git";
import { StructuredLogger } from "../logging";
import { prepareTaskRepository } from "../repo";

interface ControlPlanePort {
  registerSidekick(input: RegisterSidekickInput): Promise<SidekickRegistration>;
  reserveTask(): Promise<ReservedTask | null>;
  sendHeartbeat(input: HeartbeatInput): Promise<void>;
  sendTaskStatus(input: TaskStatusInput): Promise<void>;
  sendTaskLog(input: TaskLogInput): Promise<void>;
  sendTaskArtifact(input: TaskArtifactInput): Promise<void>;
}

export interface DaemonLoopDependencies {
  controlPlaneClient?: ControlPlanePort;
  createBackendAdapter?: (
    kind: SidekickConfig["agent"],
    options?: BackendFactoryOptions,
  ) => BackendAdapter;
  prepareTaskRepository?: typeof prepareTaskRepository;
  finalizeTaskChanges?: typeof finalizeTaskChanges;
  sleep?: (ms: number) => Promise<void>;
  getHostname?: () => string;
  now?: () => number;
}

export interface RunDaemonLoopOptions {
  shouldStop?: () => boolean;
  dependencies?: DaemonLoopDependencies;
  environment?: NodeJS.ProcessEnv;
  mirrorLogsToStderr?: boolean;
}

interface RuntimeState {
  status: SidekickRuntimeStatus;
  sidekickId?: string;
  sidekickName?: string;
  sidekickPrompt?: string;
  sidekickSteps: SidekickStep[];
  stepConfigWarnings: string[];
  currentTaskId?: string;
  currentRunId?: string;
}

interface RuntimeCounters {
  startedAtMs: number;
  completed: number;
  failed: number;
}

interface StepOutcome {
  kind: "complete" | "failed";
  failureMessage?: string;
}

const DEFAULT_MAX_STEP_ATTEMPTS = 3;
const MAX_STEP_ATTEMPTS_CAP = 10;

export async function runDaemonLoop(
  config: SidekickConfig,
  options: RunDaemonLoopOptions = {},
) {
  const dependencies = options.dependencies ?? {};
  const shouldStop = options.shouldStop ?? (() => false);
  const sleep = dependencies.sleep ?? defaultSleep;
  const getHostname = dependencies.getHostname ?? getOsHostname;
  const now = dependencies.now ?? Date.now;
  const env = options.environment ?? process.env;
  const maxStepAttempts = parseMaxStepAttempts(env);

  const controlPlaneClient =
    dependencies.controlPlaneClient ??
    new ControlPlaneClient({
      baseUrl: config.controlPlaneUrl,
      apiToken: config.apiToken,
    });

  const backendAdapter =
    dependencies.createBackendAdapter?.(config.agent, {
      logBatchSize: config.logBatchSize,
    }) ??
    createBackendAdapter(config.agent, {
      logBatchSize: config.logBatchSize,
    });

  const runPrepareTaskRepository =
    dependencies.prepareTaskRepository ?? prepareTaskRepository;
  const runFinalizeTaskChanges =
    dependencies.finalizeTaskChanges ?? finalizeTaskChanges;

  const state: RuntimeState = {
    status: "booting",
    sidekickSteps: createDefaultSidekickSteps(),
    stepConfigWarnings: [],
  };
  const counters: RuntimeCounters = {
    startedAtMs: now(),
    completed: 0,
    failed: 0,
  };

  const logger = new StructuredLogger({
    logFile: config.logFile,
    logBatchSize: config.logBatchSize,
    mirrorToStderr: options.mirrorLogsToStderr ?? false,
    getContext: () => ({
      sidekickId: state.sidekickId || "",
      sidekickName: state.sidekickName || "",
      status: state.status,
      taskId: state.currentTaskId,
      runId: state.currentRunId,
    }),
    onTaskLogBatch: async (taskId, runId, message) => {
      await safeTaskLog(controlPlaneClient, {
        id: taskId,
        runId,
        message,
      });
    },
  });

  await logger.info("runtime", `daemon booting backend=${config.agent}`);
  await refreshRegistration(
    controlPlaneClient,
    logger,
    state,
    config,
    getHostname(),
  );

  state.status = "idle";
  await logger.info("runtime", "state transition booting -> idle");

  while (!shouldStop()) {
    await sendHeartbeat(
      controlPlaneClient,
      logger,
      state,
      counters,
      now,
      config.agent,
    );

    let reservedTask: ReservedTask | null = null;
    try {
      reservedTask = await controlPlaneClient.reserveTask();
    } catch (error) {
      await logger.warn(
        "reserve_task",
        `reserve task failed: ${formatErrorMessage(error)}`,
      );
    }

    if (!reservedTask) {
      await logger.info(
        "runtime",
        `no task available; sleeping ${config.pollIntervalSeconds}s`,
      );
      await sleep(config.pollIntervalSeconds * 1_000);
      continue;
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
        maxStepAttempts,
      });
    } catch (error) {
      const message = `task processing crashed: ${formatErrorMessage(error)}`;
      await failTask(
        controlPlaneClient,
        logger,
        counters,
        reservedTask,
        message,
      );
      await endTask(logger, state);
    }
  }

  await logger.info("runtime", "shutdown requested");
  await logger.flushTaskLogs();
}

async function processTask(input: {
  task: ReservedTask;
  config: SidekickConfig;
  state: RuntimeState;
  counters: RuntimeCounters;
  logger: StructuredLogger;
  controlPlaneClient: ControlPlanePort;
  backendAdapter: BackendAdapter;
  prepareTaskRepositoryFn: typeof prepareTaskRepository;
  finalizeTaskChangesFn: typeof finalizeTaskChanges;
  env: NodeJS.ProcessEnv;
  maxStepAttempts: number;
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
    maxStepAttempts,
  } = input;

  state.status = "working";
  state.currentTaskId = task.taskId;
  state.currentRunId = task.runId;

  await logger.info(
    "task",
    `processing task id=${task.taskId} run_id=${task.runId}`,
  );
  await safeTaskStatus(controlPlaneClient, {
    id: task.taskId,
    runId: task.runId,
    status: "running",
    message: "started",
    resultUrl: "",
  });

  await refreshRegistration(
    controlPlaneClient,
    logger,
    state,
    config,
    getOsHostname(),
  );

  let repoPath = "";
  try {
    const repoResult = await prepareTaskRepositoryFn({
      reposDir: config.reposDir,
      repoName: task.repoName,
      repoUrl: task.repoUrl,
      baseBranch: task.baseBranch,
      executionBranch: task.executionBranch,
    });
    repoPath = repoResult.repoPath;

    await logger.info(
      "repo",
      `repository ready path=${repoPath} cloned=${repoResult.cloned} execution_branch_mode=${repoResult.executionBranchMode}`,
    );
    await safeTaskStatus(controlPlaneClient, {
      id: task.taskId,
      runId: task.runId,
      status: "running",
      message: "repo ready",
      resultUrl: "",
    });
  } catch (error) {
    await failTask(
      controlPlaneClient,
      logger,
      counters,
      task,
      `repo preparation failed: ${formatErrorMessage(error)}`,
    );
    await endTask(logger, state);
    return;
  }

  const backendContext: BackendRunContext = {
    env,
    onLog: (event: BackendLogEvent) => {
      void logger.log(
        event.stream === "stderr" ? "warn" : "info",
        "agent_output",
        `${event.backend}=${event.message}`,
      );
    },
  };

  const stepOutcome = await runStepWorkflow({
    task,
    state,
    logger,
    controlPlaneClient,
    backendAdapter,
    backendContext,
    repoPath,
    maxStepAttempts,
  });

  if (stepOutcome.kind === "failed") {
    await failTask(
      controlPlaneClient,
      logger,
      counters,
      task,
      stepOutcome.failureMessage ?? "step workflow failed",
    );
    await endTask(logger, state);
    return;
  }

  await safeTaskStatus(controlPlaneClient, {
    id: task.taskId,
    runId: task.runId,
    status: "running",
    message: "workflow complete",
    resultUrl: "",
  });

  const gitResult = await finalizeTaskChangesFn({
    repoPath,
    executionBranch: task.executionBranch,
    baseBranch: task.baseBranch,
    commitMessage: task.taskTitle,
    prTitle: task.taskTitle,
    prBody: task.instructions,
    env,
  });

  switch (gitResult.outcome) {
    case "success": {
      counters.completed += 1;
      await logger.info(
        "task",
        `task succeeded commit=${gitResult.commitSha ?? "unknown"} pr=${gitResult.prUrl ?? "n/a"}`,
      );
      await safeTaskStatus(controlPlaneClient, {
        id: task.taskId,
        runId: task.runId,
        status: "succeeded",
        message: gitResult.prUrl
          ? `PR opened: ${gitResult.prUrl}`
          : "PR opened",
        resultUrl: gitResult.prUrl || "",
      });
      break;
    }
    case "no_changes": {
      counters.completed += 1;
      await logger.info("task", "task succeeded with no changes");
      await safeTaskStatus(controlPlaneClient, {
        id: task.taskId,
        runId: task.runId,
        status: "succeeded",
        message: "no changes",
        resultUrl: "",
      });
      break;
    }
    default: {
      counters.failed += 1;
      await logger.error(
        "task",
        `task failed during git stage outcome=${gitResult.outcome} message=${gitResult.message}`,
      );
      await safeTaskStatus(controlPlaneClient, {
        id: task.taskId,
        runId: task.runId,
        status: "failed",
        message: gitResult.outcome,
        resultUrl: "",
      });
      break;
    }
  }

  await endTask(logger, state);
}

async function runStepWorkflow(input: {
  task: ReservedTask;
  state: RuntimeState;
  logger: StructuredLogger;
  controlPlaneClient: ControlPlanePort;
  backendAdapter: BackendAdapter;
  backendContext: BackendRunContext;
  repoPath: string;
  maxStepAttempts: number;
}): Promise<StepOutcome> {
  const {
    task,
    state,
    logger,
    controlPlaneClient,
    backendAdapter,
    backendContext,
    repoPath,
    maxStepAttempts,
  } = input;

  await emitStepConfigWarnings({
    task,
    state,
    logger,
    controlPlaneClient,
  });

  const enabledSteps = state.sidekickSteps.filter((step) => step.enabled);
  if (enabledSteps.length === 0) {
    return {
      kind: "failed",
      failureMessage: "step workflow has no enabled steps",
    };
  }

  const attemptsByStep = new Map<string, number>();
  let currentStepId = enabledSteps[0].id;

  while (true) {
    const step = enabledSteps.find((candidate) => candidate.id === currentStepId);
    if (!step) {
      return {
        kind: "failed",
        failureMessage: `step workflow transition target not found: ${currentStepId}`,
      };
    }

    const attempt = (attemptsByStep.get(step.id) ?? 0) + 1;
    attemptsByStep.set(step.id, attempt);

    const startedAt = new Date().toISOString();
    await logger.info(
      "step",
      `step start id=${step.id} name=${step.name} attempt=${attempt}/${maxStepAttempts}`,
    );

    const backendInput: BackendTaskInput = {
      repoPath,
      instructions: buildStepInstructions(task.instructions, step, attempt),
      systemPrompt: state.sidekickPrompt,
    };

    const backendResult: BackendTaskResult = await backendAdapter.runTask(
      backendInput,
      backendContext,
    );
    await logger.flushTaskLogs();

    const completedAt = new Date().toISOString();
    if (!backendResult.success) {
      const errorMessage =
        backendResult.error ?? `${backendResult.backend}: ${backendResult.summary}`;
      await logger.error(
        "step",
        `step failed id=${step.id} attempt=${attempt}/${maxStepAttempts} error=${errorMessage}`,
      );
      await safeTaskArtifact(controlPlaneClient, {
        id: task.taskId,
        runId: task.runId,
        type: `step.${step.id}`,
        payload: {
          step_id: step.id,
          step_name: step.name,
          attempt,
          max_attempts: maxStepAttempts,
          decision: "reloop",
          next_step_id: null,
          status: "failed",
          started_at: startedAt,
          completed_at: completedAt,
          output: backendResult.output,
          error: errorMessage,
        },
      });

      return {
        kind: "failed",
        failureMessage: `${backendResult.backend} failed during step ${step.id}: ${errorMessage}`,
      };
    }

    const decision = resolveStepDecision(backendResult.output);
    const nextStepId = resolveNextStepId(step, enabledSteps, decision.decision);

    if (decision.decision === "reloop" && attempt >= maxStepAttempts) {
      const loopError =
        `step '${step.id}' exceeded max attempts ` +
        `(${maxStepAttempts}) with decision=reloop`;
      await logger.error("step", `loop-limit failure ${loopError}`);
      await safeTaskArtifact(controlPlaneClient, {
        id: task.taskId,
        runId: task.runId,
        type: `step.${step.id}`,
        payload: {
          step_id: step.id,
          step_name: step.name,
          attempt,
          max_attempts: maxStepAttempts,
          decision: decision.decision,
          next_step_id: nextStepId,
          status: "failed",
          started_at: startedAt,
          completed_at: completedAt,
          output: backendResult.output,
          reason: decision.reason,
          error: loopError,
        },
      });
      return {
        kind: "failed",
        failureMessage: `loop-limit exceeded: ${loopError}`,
      };
    }

    await logger.info(
      "step",
      `step complete id=${step.id} attempt=${attempt}/${maxStepAttempts} decision=${decision.decision} next=${nextStepId ?? "complete"}`,
    );
    await safeTaskArtifact(controlPlaneClient, {
      id: task.taskId,
      runId: task.runId,
      type: `step.${step.id}`,
      payload: {
        step_id: step.id,
        step_name: step.name,
        attempt,
        max_attempts: maxStepAttempts,
        decision: decision.decision,
        next_step_id: nextStepId,
        status: "completed",
        started_at: startedAt,
        completed_at: completedAt,
        output: backendResult.output,
        reason: decision.reason,
      },
    });

    if (!nextStepId) {
      await logger.info("task", `workflow complete terminal_step=${step.id}`);
      return { kind: "complete" };
    }

    currentStepId = nextStepId;
  }
}

function resolveNextStepId(
  step: SidekickStep,
  enabledSteps: SidekickStep[],
  decision: SidekickStepDecision,
) {
  if (decision === "reloop") {
    if (step.onReloop === "self") {
      return step.id;
    }

    if (step.onReloop.startsWith("step:")) {
      return step.onReloop.slice("step:".length);
    }
  }

  if (step.onPass === "complete") {
    return null;
  }

  const stepIndex = enabledSteps.findIndex((candidate) => candidate.id === step.id);
  if (stepIndex === -1 || stepIndex === enabledSteps.length - 1) {
    return null;
  }

  return enabledSteps[stepIndex + 1].id;
}

function buildStepInstructions(
  taskInstructions: string,
  step: SidekickStep,
  attempt: number,
) {
  return [
    "You are executing one workflow step for this task.",
    `Step id: ${step.id}`,
    `Step name: ${step.name}`,
    `Step objective: ${step.prompt}`,
    `Attempt: ${attempt}`,
    "",
    "Task instructions:",
    taskInstructions,
    "",
    "At the end of your response, include a decision for this step.",
    'Accepted decision formats: {"decision":"pass"} or {"decision":"reloop","reason":"<optional>"}',
    "If no explicit decision is included, the worker defaults the step decision to pass.",
  ].join("\n");
}

function resolveStepDecision(output: string): {
  decision: SidekickStepDecision;
  reason?: string;
} {
  const trimmed = output.trim();
  if (trimmed === "pass" || trimmed === "reloop") {
    return { decision: trimmed };
  }

  const parsedAsJson = tryParseDecisionFromJson(trimmed);
  if (parsedAsJson) {
    return parsedAsJson;
  }

  const fencedJsonMatch = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (fencedJsonMatch) {
    const parsedFromFence = tryParseDecisionFromJson(fencedJsonMatch[1] ?? "");
    if (parsedFromFence) {
      return parsedFromFence;
    }
  }

  const decisionMatch = trimmed.match(/\bdecision\s*[:=]\s*(pass|reloop)\b/i);
  if (decisionMatch) {
    return {
      decision: decisionMatch[1].toLowerCase() as SidekickStepDecision,
    };
  }

  return { decision: "pass" };
}

function tryParseDecisionFromJson(
  value: string,
): { decision: SidekickStepDecision; reason?: string } | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    if (!("decision" in parsed)) {
      return null;
    }

    const decisionValue = (parsed as { decision?: unknown }).decision;
    if (decisionValue !== "pass" && decisionValue !== "reloop") {
      return null;
    }
    const decision: SidekickStepDecision = decisionValue;

    const reason = (parsed as { reason?: unknown }).reason;
    return {
      decision,
      reason: typeof reason === "string" ? reason : undefined,
    };
  } catch {
    return null;
  }
}

async function emitStepConfigWarnings(input: {
  task: ReservedTask;
  state: RuntimeState;
  logger: StructuredLogger;
  controlPlaneClient: ControlPlanePort;
}) {
  if (input.state.stepConfigWarnings.length === 0) {
    return;
  }

  for (const warning of input.state.stepConfigWarnings) {
    await input.logger.warn("step_config", warning);
    await safeTaskArtifact(input.controlPlaneClient, {
      id: input.task.taskId,
      runId: input.task.runId,
      type: "config.warning",
      payload: {
        status: "warning",
        warning,
        fallback_step_ids: input.state.sidekickSteps.map((step) => step.id),
      },
    });
  }
}

async function endTask(logger: StructuredLogger, state: RuntimeState) {
  await logger.flushTaskLogs();
  state.status = "idle";
  state.currentTaskId = undefined;
  state.currentRunId = undefined;
}

async function failTask(
  controlPlaneClient: ControlPlanePort,
  logger: StructuredLogger,
  counters: RuntimeCounters,
  task: ReservedTask,
  message: string,
) {
  counters.failed += 1;
  await logger.error("task", message);
  await safeTaskStatus(controlPlaneClient, {
    id: task.taskId,
    runId: task.runId,
    status: "failed",
    message,
    resultUrl: "",
  });
}

async function refreshRegistration(
  controlPlaneClient: ControlPlanePort,
  logger: StructuredLogger,
  state: RuntimeState,
  config: SidekickConfig,
  hostname: string,
) {
  try {
    const registration = await controlPlaneClient.registerSidekick({
      agent: config.agent,
      hostname,
      status: state.status,
    });
    if (registration.id) {
      state.sidekickId = registration.id;
    }
    state.sidekickName = registration.name;
    state.sidekickPrompt = registration.prompt;
    state.sidekickSteps = registration.steps.map((step) => ({ ...step }));
    state.stepConfigWarnings = [...registration.stepConfigWarnings];
    await logger.info(
      "registration",
      `registered sidekick id=${state.sidekickId ?? ""} name=${registration.name} purpose=${registration.purpose} steps=${registration.steps.length}`,
    );
    for (const warning of registration.stepConfigWarnings) {
      await logger.warn("registration", `step config warning: ${warning}`);
    }
  } catch (error) {
    await logger.warn(
      "registration",
      `registration refresh failed: ${formatErrorMessage(error)}`,
    );
  }
}

async function sendHeartbeat(
  controlPlaneClient: ControlPlanePort,
  logger: StructuredLogger,
  state: RuntimeState,
  counters: RuntimeCounters,
  now: () => number,
  agent: SidekickConfig["agent"],
) {
  const uptimeSeconds = Math.floor((now() - counters.startedAtMs) / 1_000);
  await logger.info(
    "heartbeat",
    `uptime=${formatUptime(uptimeSeconds)} completed=${counters.completed} failed=${counters.failed} agent=${agent}`,
  );

  try {
    await controlPlaneClient.sendHeartbeat({
      status: state.status,
    });
  } catch (error) {
    await logger.warn(
      "heartbeat",
      `heartbeat failed: ${formatErrorMessage(error)}`,
    );
  }
}

async function safeTaskStatus(
  controlPlaneClient: ControlPlanePort,
  input: TaskStatusInput,
) {
  try {
    await controlPlaneClient.sendTaskStatus(input);
  } catch {
    // Status updates should never crash task processing.
  }
}

async function safeTaskLog(
  controlPlaneClient: ControlPlanePort,
  input: TaskLogInput,
) {
  try {
    await controlPlaneClient.sendTaskLog(input);
  } catch {
    // Task log forwarding is best-effort.
  }
}

async function safeTaskArtifact(
  controlPlaneClient: ControlPlanePort,
  input: TaskArtifactInput,
) {
  try {
    await controlPlaneClient.sendTaskArtifact(input);
  } catch {
    // Artifact publishing is best-effort.
  }
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatUptime(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, "0")}h${minutes.toString().padStart(2, "0")}m${seconds.toString().padStart(2, "0")}s`;
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseMaxStepAttempts(env: NodeJS.ProcessEnv) {
  const raw = env.SIDEKICK_MAX_STEP_ATTEMPTS;
  if (!raw || raw.trim() === "") {
    return DEFAULT_MAX_STEP_ATTEMPTS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_STEP_ATTEMPTS;
  }

  if (parsed < 1) {
    return 1;
  }

  return Math.min(parsed, MAX_STEP_ATTEMPTS_CAP);
}
