import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ApiDefinition, ApiParameter } from '../../types.js'
import { toolName } from '../store.js'
import { SecureHttpExecutor } from './executor.js'

export class ApiToolRegistry {
  private disposers: Array<() => void> = []
  private names = new Set<string>()
  private readonly executor: SecureHttpExecutor

  constructor(private readonly ctx: Context) {
    this.executor = new SecureHttpExecutor(ctx)
  }

  replace(definitions: ApiDefinition[]): void {
    const enabled = definitions.filter(definition => definition.enabled)
    const names = new Set<string>()
    for (const definition of enabled) {
      const name = toolName(definition)
      if (names.has(name)) throw new Error(`Duplicate API tool name: ${name}`)
      names.add(name)
      const existing = this.ctx.tools.get(name)
      if (existing !== undefined && !this.names.has(name)) throw new Error(`Tool name is already registered: ${name}`)
    }

    this.dispose()
    const next: Array<() => void> = []
    try {
      for (const definition of enabled) next.push(this.ctx.tools.register(this.definition(definition)))
    } catch (error) {
      for (const dispose of next.reverse()) dispose()
      throw error
    }
    this.disposers = next
    this.names = names
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0).reverse()) dispose()
    this.names.clear()
  }

  private definition(definition: ApiDefinition): ToolDefinition {
    return {
      name: toolName(definition),
      description: definition.description,
      parameters: parametersSchema(definition.parameters),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'integer' },
            contentType: { type: 'string' },
            body: {},
            truncated: { type: 'boolean' },
            durationMs: { type: 'integer' },
          },
          required: ['status', 'contentType', 'body', 'truncated', 'durationMs'],
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      timeoutMs: definition.timeoutMs,
      isConcurrencySafe: () => definition.method === 'GET',
      execute: (args, exec) => this.executor.execute(definition, args, exec.signal) as unknown as Promise<JsonValue>,
      presentCall: args => ({
        card: 'generic',
        title: definition.name,
        kind: 'fetch',
        rawInput: args,
      }),
    }
  }
}

function parametersSchema(parameters: ApiParameter[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const parameter of parameters) {
    properties[parameter.name] = {
      ...parameter.type === 'json' ? {} : { type: parameter.type },
      description: parameter.description || `${parameter.location} parameter ${parameter.name}`,
    }
    if (parameter.required || parameter.location === 'path') required.push(parameter.name)
  }
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  }
}
