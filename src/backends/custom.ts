import { z } from 'zod'

import { createChatCompletion } from './custom-agent/openrouter'
import { buildSystemPrompt } from './custom-agent/prompt'
import { createToolRegistry } from './custom-agent/tools'
import type { ConversationMessage, Json } from './custom-agent/types'

import type {
  BackendAdapter,
  BackendFactoryOptions,
  BackendRunContext,
  BackendTaskInput,
  BackendTaskResult,
} from './types'

const DEFAULT_MAX_STEPS = 24
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

const backendTaskInputSchema = z.object({
  repoPath: z.string().trim().min(1, 'repoPath must be a non-empty string'),
  instructions: z
    .string()
    .trim()
    .min(1, 'instructions must be a non-empty string'),
  systemPrompt: z.string().optional(),
})

export function createCustomBackendAdapter(
  options: BackendFactoryOptions = {},
): BackendAdapter {
  return {
    kind: 'custom',
    runTask: async (input, context) => runCustomTask(input, context, options),
  }
}

async function runCustomTask(
  rawInput: BackendTaskInput,
  context: BackendRunContext | undefined,
  options: BackendFactoryOptions,
): Promise<BackendTaskResult> {
  let input: BackendTaskInput
  try {
    input = backendTaskInputSchema.parse(rawInput)
  } catch (error) {
    return asFailure('invalid custom backend task input', error, '')
  }

  const env = context?.env ?? process.env
  const model = env.OPENROUTER_MODEL ?? options.customModel
  if (!model) {
    return asFailure(
      'custom backend missing model',
      'OPENROUTER_MODEL is required',
      '',
    )
  }

  const apiKey = env.OPENROUTER_API_KEY
  if (!apiKey) {
    return asFailure(
      'custom backend missing api key',
      'OPENROUTER_API_KEY is required',
      '',
    )
  }

  const baseUrl = env.OPENROUTER_BASE_URL ?? DEFAULT_OPENROUTER_BASE_URL
  const maxSteps = parseMaxSteps(
    env.SIDEKICK_CUSTOM_MAX_STEPS,
    options.customMaxSteps,
  )

  const emitLog = (message: string) => {
    context?.onLog?.({
      backend: 'custom',
      stream: 'internal',
      message,
      timestamp: new Date().toISOString(),
    })
  }

  const toolRegistry = createToolRegistry({
    rootDir: input.repoPath,
  })
  emitLog(
    `custom backend initialized model=${model} tools=${toolRegistry.definitions.length}`,
  )

  const messages: ConversationMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt(input.repoPath, input.systemPrompt),
    },
    {
      role: 'user',
      content: `Working directory: ${input.repoPath}\n\nTask:\n${input.instructions}`,
    },
  ]

  for (let step = 1; step <= maxSteps; step += 1) {
    emitLog(`custom backend step ${step}/${maxSteps}`)

    let response: Awaited<ReturnType<typeof createChatCompletion>>
    try {
      response = await createChatCompletion({
        apiKey,
        model,
        baseUrl,
        messages,
        tools: toolRegistry.definitions,
      })
    } catch (error) {
      return asFailure('custom backend model request failed', error, '')
    }

    messages.push({
      role: 'assistant',
      content: response.content || null,
      tool_calls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
    })

    if (response.toolCalls.length === 0) {
      const output = response.content.trim()
      return {
        backend: 'custom',
        success: true,
        summary: 'custom backend task execution complete',
        output,
        exitCode: 0,
      }
    }

    for (const toolCall of response.toolCalls) {
      let parsedArgs: Record<string, Json>
      try {
        parsedArgs = parseToolArguments(toolCall.function.arguments)
      } catch (error) {
        return asFailure('custom backend could not parse tool call arguments', error, '')
      }

      emitLog(`custom backend tool ${toolCall.function.name}`)

      try {
        const result = await toolRegistry.execute(
          {
            __tool_name: toolCall.function.name,
            ...parsedArgs,
          },
          { rootDir: input.repoPath },
        )

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify(result.content, null, 2),
        })

        if (result.terminal) {
          return asTerminalToolSuccess(result.content)
        }
      } catch (error) {
        return asFailure(
          `custom backend tool execution failed (${toolCall.function.name})`,
          error,
          '',
        )
      }
    }
  }

  return asFailure(
    `custom backend reached max steps (${maxSteps})`,
    'Maximum steps reached before completion',
    '',
  )
}

function parseMaxSteps(envValue: string | undefined, optionValue: number | undefined) {
  const parsedFromEnv = z.coerce.number().int().positive().safeParse(envValue)
  if (parsedFromEnv.success) {
    return parsedFromEnv.data
  }

  const parsedFromOption = z.number().int().positive().safeParse(optionValue)
  if (parsedFromOption.success) {
    return parsedFromOption.data
  }

  return DEFAULT_MAX_STEPS
}

function parseToolArguments(value: string) {
  const parsed = JSON.parse(value) as Json
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool arguments must be a JSON object')
  }

  return parsed as Record<string, Json>
}

function asTerminalToolSuccess(content: Json): BackendTaskResult {
  const summary =
    typeof content === 'object' &&
    content !== null &&
    'summary' in content &&
    typeof content.summary === 'string'
      ? content.summary
      : 'Task complete'

  const output =
    typeof content === 'object' &&
    content !== null &&
    'output' in content &&
    typeof content.output === 'string'
      ? content.output
      : ''

  return {
    backend: 'custom',
    success: true,
    summary,
    output,
    exitCode: 0,
  }
}

function asFailure(summary: string, error: unknown, output: string): BackendTaskResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    backend: 'custom',
    success: false,
    summary,
    output,
    exitCode: null,
    error: message,
  }
}
