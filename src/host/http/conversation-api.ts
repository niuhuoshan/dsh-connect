import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { apiMethodSchema, apiParameterSchema, type ApiDefinitionView } from '../../types.js'

export const CONVERSATION_API_TOOL = 'dsh_connect_create_http_api'

export const conversationApiInput = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(2).max(48).regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1).max(1000),
  method: apiMethodSchema,
  baseUrl: z.string().url().max(2048),
  pathTemplate: z.string().min(1).max(2048).default('/'),
  parameters: z.array(apiParameterSchema).max(50).default([]),
  authType: z.enum(['none', 'bearer', 'api-key', 'basic']).default('none'),
  authLocation: z.enum(['header', 'query']).optional(),
  authName: z.string().min(1).max(100).optional(),
  basicUsername: z.string().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  maxResponseBytes: z.number().int().min(1024).max(2 * 1024 * 1024).default(131072),
  responsePointer: z.string().max(500).default(''),
}).strict().superRefine((input, refinement) => {
  if (input.authType === 'api-key') {
    if (input.authLocation === undefined) refinement.addIssue({ code: 'custom', path: ['authLocation'], message: 'Required for api-key authentication' })
    if (input.authName === undefined) refinement.addIssue({ code: 'custom', path: ['authName'], message: 'Required for api-key authentication' })
  } else if (input.authLocation !== undefined || input.authName !== undefined) {
    refinement.addIssue({ code: 'custom', path: ['authType'], message: 'API key fields are only allowed with api-key authentication' })
  }
  if (input.authType === 'basic') {
    if (input.basicUsername === undefined) refinement.addIssue({ code: 'custom', path: ['basicUsername'], message: 'Required for basic authentication' })
  } else if (input.basicUsername !== undefined) {
    refinement.addIssue({ code: 'custom', path: ['basicUsername'], message: 'Only allowed with basic authentication' })
  }
})

export type ConversationApiInput = z.infer<typeof conversationApiInput>

type CreateConversationApi = (input: ConversationApiInput) => Promise<ApiDefinitionView | undefined>
type ValidateConversationApi = (input: ConversationApiInput) => void

const parameterItem = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true, description: 'Parameter name.' },
    location: { type: 'string', enum: ['path', 'query', 'header', 'body'], required: true },
    type: { type: 'string', enum: ['string', 'number', 'integer', 'boolean', 'json'], required: true },
    description: { type: 'string', description: 'What the parameter means.' },
    required: { type: 'boolean', description: 'Whether the caller must provide this parameter.' },
  },
} as const

export function registerConversationApiTool(
  ctx: Context,
  validate: ValidateConversationApi,
  create: CreateConversationApi,
): Array<() => void> {
  const disposeTool = ctx.tools.register(defineTool({
    name: CONVERSATION_API_TOOL,
    description: [
      'Create and register a reusable HTTP API in DSH连接器 when the user asks to add, configure, or register an API.',
      'Derive this non-secret configuration from the conversation, then call this tool so DSH can show an approval preview.',
      'Never ask for or pass tokens, passwords, API-key values, Authorization values, or other credentials.',
      'For authenticated APIs, provide only the authentication type and public metadata; the user completes credentials in Settings.',
    ].join(' '),
    parameters: {
      name: { type: 'string', required: true, description: 'User-facing API name.' },
      slug: { type: 'string', required: true, description: 'Lowercase tool suffix matching ^[a-z][a-z0-9_]{1,47}$.' },
      description: { type: 'string', required: true, description: 'Describe when the Agent should call this API and what it returns.' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], required: true },
      baseUrl: { type: 'string', required: true, description: 'Public HTTP(S) base URL without credentials or a query string.' },
      pathTemplate: { type: 'string', description: 'Request path such as /v1/weather/{city}. Default /.' },
      parameters: { type: 'array', items: parameterItem, description: 'Path, query, header, and body arguments exposed to the Agent.' },
      authType: { type: 'string', enum: ['none', 'bearer', 'api-key', 'basic'], description: 'Authentication type. Default none.' },
      authLocation: { type: 'string', enum: ['header', 'query'], description: 'Required only for api-key authentication.' },
      authName: { type: 'string', description: 'Header or query parameter name for an API key, never its value.' },
      basicUsername: { type: 'string', description: 'Public username for basic authentication, never the password.' },
      timeoutMs: { type: 'integer', description: 'Timeout from 1000 to 120000 milliseconds. Default 30000.' },
      maxResponseBytes: { type: 'integer', description: 'Response limit from 1024 to 2097152 bytes. Default 131072.' },
      responsePointer: { type: 'string', description: 'Optional RFC 6901 JSON pointer selecting the useful response value.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          created: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          toolName: { type: 'string', required: true },
          enabled: { type: 'boolean', required: true },
          credentialRequired: { type: 'boolean', required: true },
          nextStep: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => false,
    async execute(rawInput) {
      const input = conversationApiInput.parse(rawInput)
      validate(input)
      const saved = await create(input)
      if (saved === undefined) throw new Error('HTTP API was saved but could not be loaded')
      const credentialRequired = saved.auth.type !== 'none' && !saved.auth.credentialConfigured
      return {
        created: true,
        id: saved.id,
        name: saved.name,
        toolName: saved.toolName,
        enabled: saved.enabled,
        credentialRequired,
        nextStep: credentialRequired
          ? '请前往“DSH连接器 → HTTP API”补充凭据并启用该 API。'
          : `API 已启用，Agent 现在可以调用 ${saved.toolName}。`,
      }
    },
    presentCall: input => ({
      card: 'generic',
      title: `创建 HTTP API：${input.name}`,
      kind: 'edit',
      rawInput: input,
    }),
  }))

  const disposeApproval = ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== CONVERSATION_API_TOOL) return next()
    const downstream = await next()
    if (downstream.kind !== 'allow') return downstream
    const parsed = conversationApiInput.safeParse(exec.arguments)
    if (!parsed.success) {
      return { kind: 'deny', reason: 'HTTP API 配置无效；对话创建不接受未声明字段或任何凭据。请修正非敏感配置后重试。' }
    }
    try {
      validate(parsed.data)
    } catch (error) {
      return { kind: 'deny', reason: safeValidationMessage(error) }
    }
    return { kind: 'ask', reason: approvalPreview(parsed.data) }
  })

  return [disposeTool, disposeApproval]
}

function approvalPreview(input: ConversationApiInput): string {
  const auth = input.authType === 'none' ? '无认证' : `${input.authType}（凭据稍后在设置中填写，此 API 将先保持禁用）`
  return [
    '确认创建以下 HTTP API：',
    `名称：${input.name}`,
    `请求：${input.method} ${previewTarget(input)}`,
    `工具：dsh_connect_api_${input.slug}`,
    `参数：${input.parameters.length} 个`,
    `认证：${auth}`,
  ].join('\n')
}

function previewTarget(input: ConversationApiInput): string {
  try {
    const path = input.pathTemplate.startsWith('/') ? input.pathTemplate : `/${input.pathTemplate}`
    return new URL(path, input.baseUrl).toString()
  } catch {
    // Full API validation runs immediately before this preview. Keep the
    // approval path total even for a malformed path that reaches this helper.
    return `${input.baseUrl.replace(/\/$/, '')}/${input.pathTemplate.replace(/^\//, '')}`
  }
}

function safeValidationMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `HTTP API 配置无效：${message.replaceAll(/[\r\n]+/g, ' ').slice(0, 500)}`
}
