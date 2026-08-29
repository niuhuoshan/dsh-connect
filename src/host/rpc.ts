import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { z } from 'zod'
import {
  apiDefinitionSchema,
  apiMethodSchema,
  apiParameterSchema,
  dataSourceSchema,
  databaseTypeSchema,
  type ApiAuth,
  type ApiDefinition,
  type DataSourceDefinition,
  type MetadataProfile,
} from '../types.js'
import { ConnectStore } from './store.js'
import { providerFor } from './datasource/index.js'
import { metadataYaml, recommendMetrics } from './metadata/governance.js'
import { MetadataProfiler } from './metadata/profiler.js'
import { ApiToolRegistry } from './http/tools.js'
import { SecureHttpExecutor } from './http/executor.js'
import type { ConversationApiInput } from './http/conversation-api.js'
import { assertSafeHeaderName, parseConfiguredBaseUrl } from './http/security.js'

const idInput = z.object({ id: z.string().uuid() })
const sourceInput = z.object({ sourceId: z.string().uuid() })
const scanInput = z.object({ sourceId: z.string().uuid(), mode: z.enum(['incremental', 'rebuild-ai', 'full']).default('incremental') })
const metadataListInput = z.object({ sourceId: z.string().uuid().optional() })
const profileInput = z.object({ id: z.string().min(1) })
const apiTestInput = z.object({ id: z.string().uuid(), args: z.record(z.string(), z.unknown()).default({}) })
const queryInput = z.object({ sourceId: z.string().uuid(), sql: z.string().min(1).max(20_000), limit: z.number().int().min(1).max(1000).default(100) })
const metricsListInput = z.object({ sourceId: z.string().uuid() })
const metricSaveInput = z.object({
  id: z.string().uuid().optional(), sourceId: z.string().uuid(), profileId: z.string().min(1),
  name: z.string().min(1).max(120), term: z.string().min(1).max(120), description: z.string().max(500).default(''),
  aggregation: z.enum(['count', 'sum', 'avg', 'min', 'max', 'formula']), columnName: z.string().max(255).default(''),
  expression: z.string().max(2000), unit: z.string().max(50).default(''), tags: z.array(z.string().max(50)).max(20).default([]), enabled: z.boolean().default(true),
})
const metricBatchSaveInput = z.object({ metrics: z.array(metricSaveInput).min(1).max(5000) })
const profileUpdateInput = z.object({
  id: z.string().min(1), term: z.string().max(100).optional(), description: z.string().max(500).optional(), tags: z.array(z.string().max(50)).max(20).optional(),
  synonyms: z.array(z.string().max(100)).max(30).optional(), ignored: z.boolean().optional(), semanticColumns: z.array(z.object({ name: z.string(), term: z.string().max(100), description: z.string().max(300), synonyms: z.array(z.string().max(100)).max(20).default([]), enums: z.array(z.string().max(100)).max(50).default([]), role: z.enum(['identifier', 'dimension', 'measure', 'time', 'unknown']).default('unknown') })).optional(),
})

const saveDataSourceInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(100),
  type: databaseTypeSchema,
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1).max(255),
  username: z.string().min(1).max(255),
  secret: z.string().min(1).optional(),
  schemaInclude: z.array(z.string().min(1).max(255)).max(100).default([]),
  tls: z.boolean().default(false),
  sampleRows: z.number().int().min(0).max(3).default(0),
  aiEnrichment: z.boolean().default(false),
  enabled: z.boolean().default(true),
})

const saveAuthInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer') }),
  z.object({ type: z.literal('api-key'), location: z.enum(['header', 'query']), name: z.string().min(1).max(100) }),
  z.object({ type: z.literal('basic'), username: z.string().min(1).max(200) }),
])

const saveApiInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(100),
  slug: z.string().min(2).max(48).regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1).max(1000),
  method: apiMethodSchema,
  baseUrl: z.string().url().max(2048),
  pathTemplate: z.string().min(1).max(2048).default('/'),
  parameters: z.array(apiParameterSchema).max(50).default([]),
  auth: saveAuthInput,
  secret: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  maxResponseBytes: z.number().int().min(1024).max(2 * 1024 * 1024).default(131072),
  responsePointer: z.string().max(500).default(''),
  allowPrivateNetwork: z.boolean().default(false),
  enabled: z.boolean().default(true),
})

export class ConnectRpc {
  private readonly executor: SecureHttpExecutor

  constructor(
    private readonly ctx: Context,
    private readonly store: ConnectStore,
    private readonly profiler: MetadataProfiler,
    private readonly tools: ApiToolRegistry,
  ) {
    this.executor = new SecureHttpExecutor(ctx)
  }

  async handle(endpoint: string, payload: unknown, signal: AbortSignal): Promise<RpcResult<unknown>> {
    try {
      switch (endpoint) {
        case 'sources/list': return ok(await this.store.dataSourceViews())
        case 'sources/save': return ok(await this.saveDataSource(saveDataSourceInput.parse(payload)))
        case 'sources/delete': return ok(await this.deleteDataSource(idInput.parse(payload).id))
        case 'sources/test': {
          const source = this.requireSource(idInput.parse(payload).id)
          await this.profiler.test(source, signal)
          return ok({ connected: true })
        }
        case 'sources/scan': {
          const input = scanInput.parse(payload)
          return ok(await this.profiler.start(input.sourceId, input.mode))
        }
        case 'sources/cancel': {
          return ok(await this.profiler.cancel(sourceInput.parse(payload).sourceId))
        }
        case 'sources/query': {
          const input = queryInput.parse(payload)
          const source = this.requireSource(input.sourceId)
          if (!source.enabled) throw new Error('Data source is disabled')
          const password = await this.ctx.credentials.resolve(credentialRef(source.credentialRef))
          if (password === undefined) throw new Error('Database credential is not configured')
          return ok(await providerFor(source.type).query(source, password.value, input.sql, input.limit, signal))
        }
        case 'jobs/list': return ok(this.store.jobs(sourceInput.parse(payload).sourceId))
        case 'metadata/list': return ok(this.store.profiles(metadataListInput.parse(payload).sourceId))
        case 'metadata/get': {
          const profile = this.store.profile(profileInput.parse(payload).id)
          if (profile === undefined) throw new Error('Metadata profile not found')
          return ok(profile)
        }
        case 'metadata/update': return ok(await this.updateMetadata(profileUpdateInput.parse(payload)))
        case 'metadata/yaml': {
          const input = sourceInput.parse(payload)
          return ok(metadataYaml(this.store.profiles(input.sourceId), this.store.metrics(input.sourceId), input.sourceId))
        }
        case 'metadata/changes': {
          const input = z.object({
            sourceId: z.string().uuid(),
            profileId: z.string().min(1).optional(),
            offset: z.number().int().min(0).default(0),
            limit: z.number().int().min(1).max(100).default(20),
          }).parse(payload)
          return ok(this.store.changePage(input.sourceId, input.profileId, input.offset, input.limit))
        }
        case 'metrics/list': return ok(this.store.metrics(metricsListInput.parse(payload).sourceId))
        case 'metrics/recommend': {
          const input = metricsListInput.parse(payload)
          return ok(recommendMetrics(this.store.profiles(input.sourceId), input.sourceId, this.store.metrics(input.sourceId)))
        }
        case 'metrics/save': return ok(await this.saveMetric(metricSaveInput.parse(payload)))
        case 'metrics/save-batch': {
          const input = metricBatchSaveInput.parse(payload)
          const saved = []
          for (const metric of input.metrics) saved.push(await this.saveMetric(metric))
          return ok({ saved: saved.length })
        }
        case 'metrics/delete': {
          const metric = this.store.metric(idInput.parse(payload).id)
          if (metric === undefined) throw new Error('Metric not found')
          await this.store.deleteMetric(metric.id)
          await this.store.putChange({ id: randomUUID(), sourceId: metric.sourceId, profileId: metric.profileId, action: 'update', summary: `删除指标：${metric.term}`, before: { metric }, changedAt: Date.now() })
          return ok({ deleted: true })
        }
        case 'apis/list': return ok(await this.store.apiDefinitionViews())
        case 'apis/save': return ok(await this.saveApi(saveApiInput.parse(payload)))
        case 'apis/delete': return ok(await this.deleteApi(idInput.parse(payload).id))
        case 'apis/test': {
          const input = apiTestInput.parse(payload)
          const definition = this.requireApi(input.id)
          return ok(await this.executor.execute(definition, input.args, signal))
        }
        default: return badRequest(`Unknown dsh-connect endpoint: ${endpoint}`)
      }
    } catch (error) {
      if (signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'Request cancelled', details: {} } }
      if (error instanceof z.ZodError) return badRequest('Invalid dsh-connect request', error.issues)
      return { ok: false, error: { code: 'internal', message: safeError(error), details: {} } }
    }
  }

  validateConversationApi(input: ConversationApiInput): void {
    const prepared = this.prepareConversationApi(input)
    if (this.store.apiDefinitions().some(api => api.slug === prepared.slug)) {
      throw new Error(`API slug already exists: ${prepared.slug}`)
    }
    const baseUrl = parseConfiguredBaseUrl(prepared.baseUrl)
    if (baseUrl.search !== '') throw new Error('Base URL query strings are not allowed; declare query parameters instead')
    if (prepared.pathTemplate.includes('?')) throw new Error('Path template query strings are not allowed; declare query parameters instead')
    validateApiInput(prepared)
  }

  async createConversationApi(input: ConversationApiInput) {
    const prepared = this.prepareConversationApi(input)
    this.validateConversationApi(input)
    return this.saveApi(prepared, { allowMissingCredential: true })
  }

  private async saveDataSource(input: z.infer<typeof saveDataSourceInput>) {
    const existing = input.id === undefined ? undefined : this.store.dataSource(input.id)
    if (input.id !== undefined && existing === undefined) throw new Error('Data source not found')
    const duplicate = this.store.dataSources().find(source => source.name === input.name && source.id !== input.id)
    if (duplicate !== undefined) throw new Error(`Data source name already exists: ${input.name}`)
    const id = existing?.id ?? randomUUID()
    const credentialName = existing?.credentialRef ?? databaseCredentialRef(id)
    if (existing === undefined && input.secret === undefined) throw new Error('Password is required for a new data source')
    if (input.secret !== undefined) await this.ctx.credentials.set(credentialRef(credentialName), input.secret)
    const now = Date.now()
    const definition = dataSourceSchema.parse({
      id,
      name: input.name.trim(),
      type: input.type,
      host: input.host.trim(),
      port: input.port,
      database: input.database.trim(),
      username: input.username.trim(),
      credentialRef: credentialName,
      schemaInclude: input.schemaInclude.map(value => value.trim()).filter(Boolean),
      tls: input.tls,
      sampleRows: input.sampleRows,
      aiEnrichment: input.aiEnrichment,
      enabled: input.enabled,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    await this.store.putDataSource(definition)
    return (await this.store.dataSourceViews()).find(source => source.id === id)
  }

  private async deleteDataSource(id: string) {
    const existing = this.requireSource(id)
    await this.profiler.cancel(id)
    await this.store.deleteDataSource(id)
    await this.unsetIfWritable(existing.credentialRef)
    return { deleted: true }
  }

  private async saveApi(
    input: z.infer<typeof saveApiInput>,
    options: { allowMissingCredential?: boolean } = {},
  ) {
    const existing = input.id === undefined ? undefined : this.store.apiDefinition(input.id)
    if (input.id !== undefined && existing === undefined) throw new Error('API definition not found')
    const duplicate = this.store.apiDefinitions().find(api => api.slug === input.slug && api.id !== input.id)
    if (duplicate !== undefined) throw new Error(`API slug already exists: ${input.slug}`)
    validateApiInput(input)
    const id = existing?.id ?? randomUUID()
    const nextAuth = await this.resolveApiAuth(id, input.auth, input.secret, existing?.auth, options.allowMissingCredential ?? false)
    const now = Date.now()
    const definition = apiDefinitionSchema.parse({
      id,
      name: input.name.trim(),
      slug: input.slug,
      description: input.description.trim(),
      method: input.method,
      baseUrl: input.baseUrl,
      pathTemplate: input.pathTemplate,
      parameters: input.parameters,
      auth: nextAuth,
      timeoutMs: input.timeoutMs,
      maxResponseBytes: input.maxResponseBytes,
      responsePointer: input.responsePointer,
      allowPrivateNetwork: input.allowPrivateNetwork,
      enabled: input.enabled,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    await this.store.putApiDefinition(definition)
    try {
      this.tools.replace(this.store.apiDefinitions())
    } catch (error) {
      if (existing === undefined) await this.store.deleteApiDefinition(id)
      else await this.store.putApiDefinition(existing)
      this.tools.replace(this.store.apiDefinitions())
      throw error
    }
    if (existing !== undefined && existing.auth.type !== 'none' && nextAuth.type === 'none') {
      await this.unsetIfWritable(existing.auth.credentialRef)
    }
    return (await this.store.apiDefinitionViews()).find(api => api.id === id)
  }

  private async deleteApi(id: string) {
    const existing = this.requireApi(id)
    await this.store.deleteApiDefinition(id)
    this.tools.replace(this.store.apiDefinitions())
    if (existing.auth.type !== 'none') await this.unsetIfWritable(existing.auth.credentialRef)
    return { deleted: true }
  }

  private async resolveApiAuth(
    id: string,
    input: z.infer<typeof saveAuthInput>,
    secret: string | undefined,
    existing: ApiAuth | undefined,
    allowMissingCredential: boolean,
  ): Promise<ApiAuth> {
    if (input.type === 'none') return { type: 'none' }
    const ref = existing?.type === 'none' || existing === undefined ? apiCredentialRef(id) : existing.credentialRef
    const configured = (await this.ctx.credentials.describe(credentialRef(ref))).configured
    if (!configured && secret === undefined && !allowMissingCredential) throw new Error('Credential is required for this authentication method')
    if (secret !== undefined) await this.ctx.credentials.set(credentialRef(ref), secret)
    if (input.type === 'bearer') return { type: 'bearer', credentialRef: ref }
    if (input.type === 'basic') return { type: 'basic', credentialRef: ref, username: input.username }
    return { type: 'api-key', credentialRef: ref, location: input.location, name: input.name }
  }

  private prepareConversationApi(input: ConversationApiInput): z.infer<typeof saveApiInput> {
    const auth = input.authType === 'none'
      ? { type: 'none' as const }
      : input.authType === 'bearer'
        ? { type: 'bearer' as const }
        : input.authType === 'basic'
          ? { type: 'basic' as const, username: input.basicUsername ?? '' }
          : { type: 'api-key' as const, location: input.authLocation ?? 'header', name: input.authName ?? '' }
    return saveApiInput.parse({
      name: input.name,
      slug: input.slug,
      description: input.description,
      method: input.method,
      baseUrl: input.baseUrl,
      pathTemplate: input.pathTemplate,
      parameters: input.parameters,
      auth,
      timeoutMs: input.timeoutMs,
      maxResponseBytes: input.maxResponseBytes,
      responsePointer: input.responsePointer,
      allowPrivateNetwork: false,
      enabled: input.authType === 'none',
    })
  }

  private requireSource(id: string): DataSourceDefinition {
    const source = this.store.dataSource(id)
    if (source === undefined) throw new Error('Data source not found')
    return source
  }

  private requireApi(id: string): ApiDefinition {
    const definition = this.store.apiDefinition(id)
    if (definition === undefined) throw new Error('API definition not found')
    return definition
  }

  private async updateMetadata(input: z.infer<typeof profileUpdateInput>): Promise<MetadataProfile> {
    const existing = this.store.profile(input.id)
    if (existing === undefined) throw new Error('Metadata profile not found')
    const next: MetadataProfile = {
      ...existing,
      ...(input.term === undefined ? {} : { term: input.term.trim() }),
      ...(input.description === undefined ? {} : { description: input.description.trim() }),
      ...(input.tags === undefined ? {} : { tags: [...new Set(input.tags.map(tag => tag.trim()).filter(Boolean))] }),
      ...(input.synonyms === undefined ? {} : { synonyms: [...new Set(input.synonyms.map(value => value.trim()).filter(Boolean))] }),
      ...(input.ignored === undefined ? {} : { ignored: input.ignored, ignoredOverride: input.ignored }),
      ...(input.semanticColumns === undefined ? {} : { semanticColumns: input.semanticColumns }),
      editedAt: Date.now(),
    }
    await this.store.putProfile(next)
    await this.store.putChange({ id: randomUUID(), sourceId: next.sourceId, profileId: next.id, action: 'update', summary: '手动更新元数据', before: { term: existing.term, description: existing.description, tags: existing.tags, synonyms: existing.synonyms, ignored: existing.ignored }, after: { term: next.term, description: next.description, tags: next.tags, synonyms: next.synonyms, ignored: next.ignored }, changedAt: Date.now() })
    return next
  }

  private async saveMetric(input: z.infer<typeof metricSaveInput>) {
    const existing = input.id === undefined ? undefined : this.store.metric(input.id)
    if (input.id !== undefined && existing === undefined) throw new Error('Metric not found')
    if (this.store.profile(input.profileId)?.sourceId !== input.sourceId) throw new Error('Metric profile does not belong to this data source')
    if (this.store.metrics(input.sourceId).some(metric => metric.name === input.name && metric.id !== input.id)) throw new Error(`Metric name already exists: ${input.name}`)
    const now = Date.now()
    const metric = {
      ...input,
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await this.store.putMetric(metric)
    await this.store.putChange({ id: randomUUID(), sourceId: metric.sourceId, profileId: metric.profileId, action: 'update', summary: `${existing === undefined ? '创建' : '更新'}指标：${metric.term}`, ...(existing === undefined ? {} : { before: { metric: existing } }), after: { metric }, changedAt: Date.now() })
    return metric
  }

  private async unsetIfWritable(ref: string): Promise<void> {
    const info = await this.ctx.credentials.describe(credentialRef(ref))
    if (info.configured && info.writable) await this.ctx.credentials.unset(credentialRef(ref))
  }
}

function validateApiInput(input: z.infer<typeof saveApiInput>): void {
  parseConfiguredBaseUrl(input.baseUrl)
  if (input.responsePointer !== '' && !input.responsePointer.startsWith('/')) {
    throw new Error('Response pointer must be empty or start with /')
  }
  const names = new Set<string>()
  for (const parameter of input.parameters) {
    if (names.has(parameter.name)) throw new Error(`Duplicate API parameter: ${parameter.name}`)
    names.add(parameter.name)
    if (parameter.location === 'header') assertSafeHeaderName(parameter.name)
    if (parameter.location === 'path' && !input.pathTemplate.includes(`{${parameter.name}}`)) {
      throw new Error(`Path parameter ${parameter.name} has no matching placeholder`)
    }
  }
  for (const match of input.pathTemplate.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1]
    if (name === undefined || !input.parameters.some(parameter => parameter.name === name && parameter.location === 'path')) {
      throw new Error(`Path placeholder ${name ?? ''} has no path parameter definition`)
    }
  }
  if (input.auth.type === 'api-key' && input.auth.location === 'header') assertSafeHeaderName(input.auth.name)
}

function databaseCredentialRef(id: string): string {
  return `DSH_CONNECT_DB_${id.replaceAll('-', '_').toUpperCase()}_PASSWORD`
}

function apiCredentialRef(id: string): string {
  return `DSH_CONNECT_API_${id.replaceAll('-', '_').toUpperCase()}_SECRET`
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function badRequest(message: string, issues: z.core.$ZodIssue[] = []): RpcResult<never> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues } } }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/[\r\n]+/g, ' ').slice(0, 1000)
}
