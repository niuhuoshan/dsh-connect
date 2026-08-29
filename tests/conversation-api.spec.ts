import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import {
  CONVERSATION_API_TOOL,
  conversationApiInput,
  registerConversationApiTool,
  type ConversationApiInput,
} from '../src/host/http/conversation-api.js'
import { ConnectRpc } from '../src/host/rpc.js'
import type { ApiDefinition, ApiDefinitionView } from '../src/types.js'

describe('conversational HTTP API creation', () => {
  it('requires approval with a structured non-secret preview', async () => {
    const harness = registrationHarness()
    registerConversationApiTool(harness.ctx, () => {}, async () => view())

    const decision = await harness.approval!(execution(input()), async () => ({ kind: 'allow' }))

    expect(decision).toMatchObject({ kind: 'ask' })
    if (decision.kind !== 'ask') throw new Error('expected approval')
    expect(decision.reason).toContain('名称：上海天气')
    expect(decision.reason).toContain('工具：dsh_connect_api_shanghai_weather')
    expect(decision.reason).not.toMatch(/password|secret|token/i)
  })

  it('rejects credential fields before asking for approval', async () => {
    const harness = registrationHarness()
    registerConversationApiTool(harness.ctx, () => {}, async () => view())

    const decision = await harness.approval!(
      execution({ ...input(), secret: 'must-not-enter-a-tool-call' }),
      async () => ({ kind: 'allow' }),
    )

    expect(decision).toMatchObject({ kind: 'deny' })
    if (decision.kind !== 'deny') throw new Error('expected denial')
    expect(decision.reason).not.toContain('must-not-enter-a-tool-call')
  })

  it('does not intercept unrelated tools or override downstream policy', async () => {
    const harness = registrationHarness()
    registerConversationApiTool(harness.ctx, () => {}, async () => view())
    const denied = { kind: 'deny' as const, reason: 'deployment policy' }

    await expect(harness.approval!(execution({}, 'other_tool'), async () => denied)).resolves.toBe(denied)
    await expect(harness.approval!(execution(input()), async () => denied)).resolves.toBe(denied)
  })

  it('creates an unauthenticated API through the registered tool', async () => {
    const harness = registrationHarness()
    const create = vi.fn(async () => view())
    registerConversationApiTool(harness.ctx, () => {}, create)

    const result = await harness.tool!.execute(input(), {} as never)

    expect(create).toHaveBeenCalledWith(conversationApiInput.parse(input()))
    expect(result).toMatchObject({ created: true, enabled: true, credentialRequired: false })
  })

  it('persists authenticated APIs disabled without accepting a credential', async () => {
    const definitions: ApiDefinition[] = []
    const replace = vi.fn()
    const context = {
      credentials: {
        describe: vi.fn(async () => ({ configured: false, writable: true })),
        set: vi.fn(),
      },
    } as unknown as Context
    const store = {
      apiDefinition: (id: string) => definitions.find(api => api.id === id),
      apiDefinitions: () => [...definitions],
      putApiDefinition: async (definition: ApiDefinition) => {
        const index = definitions.findIndex(api => api.id === definition.id)
        if (index < 0) definitions.push(definition)
        else definitions[index] = definition
      },
      deleteApiDefinition: async (id: string) => {
        const index = definitions.findIndex(api => api.id === id)
        if (index < 0) return false
        definitions.splice(index, 1)
        return true
      },
      apiDefinitionViews: async () => definitions.map(definition => definitionView(definition, false)),
    }
    const rpc = new ConnectRpc(context, store as never, {} as never, { replace } as never)

    const saved = await rpc.createConversationApi(input({
      slug: 'secure_weather',
      authType: 'api-key',
      authLocation: 'header',
      authName: 'X-API-Key',
    }))

    expect(saved).toMatchObject({ slug: 'secure_weather', enabled: false, auth: { type: 'api-key', credentialConfigured: false } })
    expect(definitions[0]).toMatchObject({
      slug: 'secure_weather',
      enabled: false,
      allowPrivateNetwork: false,
      auth: { type: 'api-key', location: 'header', name: 'X-API-Key' },
    })
    expect(context.credentials.set).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledOnce()
  })

  it('rejects fixed query strings and duplicate slugs', async () => {
    const { rpc, definitions } = rpcHarness()
    rpc.validateConversationApi(input())
    expect(() => rpc.validateConversationApi(input({ baseUrl: 'https://api.example.com?token=value' }))).toThrow('query strings are not allowed')
    expect(() => rpc.validateConversationApi(input({ pathTemplate: '/v1/weather?key=value' }))).toThrow('query strings are not allowed')

    await rpc.createConversationApi(input())
    expect(definitions).toHaveLength(1)
    await expect(rpc.createConversationApi(input())).rejects.toThrow('API slug already exists')
  })
})

function input(overrides: Partial<ConversationApiInput> = {}): ConversationApiInput {
  return conversationApiInput.parse({
    name: '上海天气',
    slug: 'shanghai_weather',
    description: '查询上海实时天气',
    method: 'GET',
    baseUrl: 'https://api.example.com',
    pathTemplate: '/v1/weather',
    parameters: [],
    authType: 'none',
    ...overrides,
  })
}

function view(): ApiDefinitionView {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: '上海天气',
    slug: 'shanghai_weather',
    description: '查询上海实时天气',
    method: 'GET',
    baseUrl: 'https://api.example.com',
    pathTemplate: '/v1/weather',
    parameters: [],
    auth: { type: 'none', credentialConfigured: true },
    timeoutMs: 30000,
    maxResponseBytes: 131072,
    responsePointer: '',
    allowPrivateNetwork: false,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    toolName: 'dsh_connect_api_shanghai_weather',
  }
}

function definitionView(definition: ApiDefinition, configured: boolean): ApiDefinitionView {
  const { auth, ...safe } = definition
  return {
    ...safe,
    auth: auth.type === 'none'
      ? { type: 'none', credentialConfigured: true }
      : auth.type === 'bearer'
        ? { type: 'bearer', credentialConfigured: configured }
        : auth.type === 'basic'
          ? { type: 'basic', username: auth.username, credentialConfigured: configured }
          : { type: 'api-key', location: auth.location, name: auth.name, credentialConfigured: configured },
    toolName: `dsh_connect_api_${definition.slug}`,
  }
}

function registrationHarness() {
  let tool: ToolDefinition | undefined
  let approval: ((exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
  const ctx = {
    tools: {
      register(definition: ToolDefinition) {
        tool = definition
        return () => {}
      },
    },
    on(event: string, listener: typeof approval) {
      if (event === 'tools/pre-execute') approval = listener
      return () => {}
    },
  } as unknown as Context
  return {
    ctx,
    get tool() { return tool },
    get approval() { return approval },
  }
}

function execution(arguments_: unknown, name = CONVERSATION_API_TOOL): ToolExecution {
  return { name, arguments: arguments_ } as ToolExecution
}

function rpcHarness() {
  const definitions: ApiDefinition[] = []
  const store = {
    apiDefinition: (id: string) => definitions.find(api => api.id === id),
    apiDefinitions: () => [...definitions],
    putApiDefinition: async (definition: ApiDefinition) => { definitions.push(definition) },
    deleteApiDefinition: async () => true,
    apiDefinitionViews: async () => definitions.map(definition => definitionView(definition, true)),
  }
  const context = { credentials: { describe: async () => ({ configured: true }) } } as unknown as Context
  return { rpc: new ConnectRpc(context, store as never, {} as never, { replace: () => {} } as never), definitions }
}
