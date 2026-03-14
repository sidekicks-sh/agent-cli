import type { BackendKind } from '../backends'

export type SidekickRuntimeStatus = 'booting' | 'idle' | 'working'
export type TaskExecutionStatus = 'running' | 'succeeded' | 'failed'

export interface RegisterSidekickInput {
  agent: BackendKind
  hostname: string
  status: SidekickRuntimeStatus
}

export interface SidekickRegistration {
  id?: string
  name: string
  purpose: string
  prompt: string
}

export interface ReservedTask {
  taskId: string
  runId: string
  taskTitle: string
  repoUrl: string
  repoName: string
  baseBranch: string
  executionBranch: string
  instructions: string
}

export interface HeartbeatInput {
  status: SidekickRuntimeStatus
}

export interface TaskStatusInput {
  id: string
  runId: string
  status: TaskExecutionStatus
  message: string
}

export interface TaskLogInput {
  id: string
  runId: string
  message: string
}

export interface ControlPlaneTelemetryRequestEvent {
  type: 'request'
  requestId: string
  method: string
  url: string
  attempt: number
}

export interface ControlPlaneTelemetryResponseEvent {
  type: 'response'
  requestId: string
  method: string
  url: string
  attempt: number
  status: number
  elapsedMs: number
}

export interface ControlPlaneTelemetryRetryEvent {
  type: 'retry'
  requestId: string
  method: string
  url: string
  attempt: number
  reason: string
  backoffMs: number
}

export interface ControlPlaneTelemetryErrorEvent {
  type: 'error'
  requestId: string
  method: string
  url: string
  attempt: number
  reason: string
}

export type ControlPlaneTelemetryEvent =
  | ControlPlaneTelemetryRequestEvent
  | ControlPlaneTelemetryResponseEvent
  | ControlPlaneTelemetryRetryEvent
  | ControlPlaneTelemetryErrorEvent

export type ControlPlaneTelemetryHook = (
  event: ControlPlaneTelemetryEvent,
) => void

export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export interface ControlPlaneClientOptions {
  baseUrl: string
  apiToken: string
  fetchImpl?: FetchLike
  telemetry?: ControlPlaneTelemetryHook
  retryPolicy?: Partial<RetryPolicy>
}

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>
