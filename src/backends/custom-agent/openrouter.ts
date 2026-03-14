import type { ConversationMessage, ToolCall, ToolDefinition } from './types'

interface OpenRouterResponse {
  choices?: Array<{
    finish_reason?: string | null
    message?: {
      role?: 'assistant'
      content?: string | Array<{ text?: string; type?: string }> | null
      tool_calls?: ToolCall[]
      toolCalls?: ToolCall[]
    }
  }>
  error?: {
    message?: string
  }
}

export interface OpenRouterTurnResult {
  content: string
  toolCalls: ToolCall[]
  finishReason?: string | null
}

export async function createChatCompletion(input: {
  apiKey: string
  model: string
  baseUrl: string
  messages: ConversationMessage[]
  tools: ToolDefinition[]
}) {
  const response = await fetch(`${input.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
      'http-referer': 'https://github.com/sidekicks-sh',
      'x-title': 'sidekick-agent',
    },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      tools: input.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      tool_choice: 'auto',
      parallel_tool_calls: false,
      temperature: 0.1,
    }),
  })

  const data = (await response.json()) as OpenRouterResponse

  if (!response.ok) {
    throw new Error(
      `OpenRouter request failed (${response.status} ${response.statusText}): ${data.error?.message ?? JSON.stringify(data)}`,
    )
  }

  const choice = data.choices?.[0]
  if (!choice?.message) {
    throw new Error(`OpenRouter returned no message: ${JSON.stringify(data)}`)
  }

  return {
    content: normalizeContent(choice.message.content),
    toolCalls: choice.message.tool_calls ?? choice.message.toolCalls ?? [],
    finishReason: choice.finish_reason,
  } satisfies OpenRouterTurnResult
}

function normalizeContent(
  content: string | Array<{ text?: string; type?: string }> | null | undefined,
) {
  if (typeof content === 'string') {
    return content
  }

  if (!content) {
    return ''
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part?.text === 'string') {
          return part.text
        }
        return JSON.stringify(part)
      })
      .join('\n')
      .trim()
  }

  return ''
}
