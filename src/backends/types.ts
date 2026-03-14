export const SUPPORTED_BACKENDS = [
  'custom',
  'codex',
  'claude',
  'opencode',
] as const

export type BackendKind = (typeof SUPPORTED_BACKENDS)[number]

export const DEFAULT_BACKEND: BackendKind = 'custom'

export type BackendLogStream = 'stdout' | 'stderr' | 'internal'

export interface BackendLogEvent {
  backend: BackendKind
  stream: BackendLogStream
  message: string
  timestamp: string
}

export interface BackendTaskInput {
  repoPath: string
  instructions: string
  systemPrompt?: string
}

export interface BackendRunContext {
  env?: NodeJS.ProcessEnv
  onLog?: (event: BackendLogEvent) => void
}

export interface BackendTaskResult {
  backend: BackendKind
  success: boolean
  summary: string
  output: string
  exitCode: number | null
  error?: string
}

export interface BackendAdapter {
  kind: BackendKind
  runTask(
    input: BackendTaskInput,
    context?: BackendRunContext,
  ): Promise<BackendTaskResult>
}

export interface BackendFactoryOptions {
  logBatchSize?: number
  customModel?: string
  customMaxSteps?: number
}
