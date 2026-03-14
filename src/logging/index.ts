import { appendFile } from 'node:fs/promises'

import type { SidekickRuntimeStatus } from '../control-plane'

export type LogLevel = 'info' | 'warn' | 'error'

export interface StructuredLogContext {
  sidekickId: string
  sidekickName: string
  status: SidekickRuntimeStatus
  taskId?: string
  runId?: string
}

export interface StructuredLoggerOptions {
  logFile: string
  logBatchSize: number
  getContext: () => StructuredLogContext
  mirrorToStderr?: boolean
  writeMirrorLine?: (line: string) => void
  onTaskLogBatch?: (
    taskId: string,
    runId: string,
    message: string,
  ) => Promise<void>
}

export class StructuredLogger {
  private readonly logFile: string
  private readonly logBatchSize: number
  private readonly getContext: () => StructuredLogContext
  private readonly mirrorToStderr: boolean
  private readonly writeMirrorLine: (line: string) => void
  private readonly onTaskLogBatch?: (
    taskId: string,
    runId: string,
    message: string,
  ) => Promise<void>
  private queuedTaskLogLines: string[] = []
  private pendingTaskLogFlush: Promise<void> = Promise.resolve()

  constructor(options: StructuredLoggerOptions) {
    this.logFile = options.logFile
    this.logBatchSize = Math.max(1, options.logBatchSize)
    this.getContext = options.getContext
    this.mirrorToStderr = options.mirrorToStderr ?? false
    this.writeMirrorLine =
      options.writeMirrorLine ??
      ((line) => {
        process.stderr.write(`${line}\n`)
      })
    this.onTaskLogBatch = options.onTaskLogBatch
  }

  async info(event: string, message: string) {
    await this.log('info', event, message)
  }

  async warn(event: string, message: string) {
    await this.log('warn', event, message)
  }

  async error(event: string, message: string) {
    await this.log('error', event, message)
  }

  async log(level: LogLevel, event: string, message: string) {
    const context = this.getContext()
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      sidekick_id: context.sidekickId,
      sidekick_name: context.sidekickName,
      status: context.status,
      message,
    })

    await appendFile(this.logFile, `${line}\n`, 'utf8')
    if (this.mirrorToStderr) {
      this.writeMirrorLine(line)
    }
    this.enqueueTaskLog(context, line)
  }

  async flushTaskLogs() {
    this.pendingTaskLogFlush = this.pendingTaskLogFlush.then(async () => {
      await this.flushTaskLogBuffer()
    })
    return this.pendingTaskLogFlush
  }

  private enqueueTaskLog(context: StructuredLogContext, line: string) {
    if (!context.taskId || !context.runId || !this.onTaskLogBatch) {
      return
    }

    this.queuedTaskLogLines.push(line)
    if (this.queuedTaskLogLines.length < this.logBatchSize) {
      return
    }

    this.pendingTaskLogFlush = this.pendingTaskLogFlush.then(async () => {
      await this.flushTaskLogBuffer()
    })
  }

  private async flushTaskLogBuffer() {
    if (!this.onTaskLogBatch || this.queuedTaskLogLines.length === 0) {
      return
    }

    const context = this.getContext()
    if (!context.taskId || !context.runId) {
      this.queuedTaskLogLines = []
      return
    }

    const payload = this.queuedTaskLogLines.join('\n')
    this.queuedTaskLogLines = []
    await this.onTaskLogBatch(context.taskId, context.runId, payload)
  }
}
