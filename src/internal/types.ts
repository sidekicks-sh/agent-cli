export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json }

export interface CliArgs {
  prompt: string
  model: string
  cwd: string
  systemPrompt?: string
  maxSteps: number
  help: boolean
  version: boolean
}

export interface ToolSchema {
  type: 'object'
  properties?: Record<string, Json>
  required?: string[]
  [key: string]: Json | undefined
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: ToolSchema
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export type ConversationMessage =
  | {
      role: 'system' | 'user'
      content: string
    }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: ToolCall[]
    }
  | {
      role: 'tool'
      tool_call_id: string
      name: string
      content: string
    }

export interface ToolExecutionContext {
  rootDir: string
}

export interface ToolExecutionResult {
  ok: boolean
  content: Json
  terminal?: boolean
}
