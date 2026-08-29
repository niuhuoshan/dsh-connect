import { z } from 'zod'

export const databaseTypeSchema = z.enum(['mysql', 'postgresql', 'clickhouse'])
export type DatabaseType = z.infer<typeof databaseTypeSchema>

export const apiMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
export type ApiMethod = z.infer<typeof apiMethodSchema>

export const apiParameterSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[A-Za-z_][A-Za-z0-9_-]*$/),
  location: z.enum(['path', 'query', 'header', 'body']),
  type: z.enum(['string', 'number', 'integer', 'boolean', 'json']),
  description: z.string().max(500).default(''),
  required: z.boolean().default(false),
})
export type ApiParameter = z.infer<typeof apiParameterSchema>

export const apiAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), credentialRef: z.string().min(1) }),
  z.object({
    type: z.literal('api-key'),
    credentialRef: z.string().min(1),
    location: z.enum(['header', 'query']),
    name: z.string().min(1).max(100),
  }),
  z.object({ type: z.literal('basic'), credentialRef: z.string().min(1), username: z.string().min(1).max(200) }),
])
export type ApiAuth = z.infer<typeof apiAuthSchema>

export type ApiAuthView =
  | { type: 'none'; credentialConfigured: boolean }
  | { type: 'bearer'; credentialConfigured: boolean }
  | { type: 'api-key'; credentialConfigured: boolean; location: 'header' | 'query'; name: string }
  | { type: 'basic'; credentialConfigured: boolean; username: string }

const timestampSchema = z.number().int().nonnegative()

export const dataSourceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  type: databaseTypeSchema,
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1).max(255),
  username: z.string().min(1).max(255),
  credentialRef: z.string().min(1),
  schemaInclude: z.array(z.string().min(1).max(255)).max(100).default([]),
  tls: z.boolean().default(false),
  sampleRows: z.number().int().min(0).max(3).default(0),
  aiEnrichment: z.boolean().default(false),
  enabled: z.boolean().default(true),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})
export type DataSourceDefinition = z.infer<typeof dataSourceSchema>

export const apiDefinitionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  slug: z.string().min(2).max(48).regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1).max(1000),
  method: apiMethodSchema,
  baseUrl: z.string().url().max(2048),
  pathTemplate: z.string().min(1).max(2048).default('/'),
  parameters: z.array(apiParameterSchema).max(50).default([]),
  auth: apiAuthSchema,
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  maxResponseBytes: z.number().int().min(1024).max(2 * 1024 * 1024).default(131072),
  responsePointer: z.string().max(500).default(''),
  allowPrivateNetwork: z.boolean().default(false),
  enabled: z.boolean().default(true),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})
export type ApiDefinition = z.infer<typeof apiDefinitionSchema>

export const physicalColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean(),
  defaultValue: z.string().nullable().optional(),
  comment: z.string().optional(),
  primaryKey: z.boolean().default(false),
  references: z.object({
    schemaName: z.string(),
    objectName: z.string(),
    columnName: z.string(),
  }).optional(),
})
export type PhysicalColumn = z.infer<typeof physicalColumnSchema>

export const semanticColumnSchema = z.object({
  name: z.string(),
  term: z.string(),
  description: z.string(),
  synonyms: z.array(z.string().max(100)).max(20).default([]),
  enums: z.array(z.string().max(100)).max(50).default([]),
  role: z.enum(['identifier', 'dimension', 'measure', 'time', 'unknown']).default('unknown'),
})
export type SemanticColumn = z.infer<typeof semanticColumnSchema>

export const metadataProfileSchema = z.object({
  id: z.string(),
  sourceId: z.string().uuid(),
  schemaName: z.string(),
  objectName: z.string(),
  objectType: z.enum(['table', 'view']),
  engine: z.string().optional(),
  comment: z.string().optional(),
  ddl: z.string().max(100000),
  columns: z.array(physicalColumnSchema),
  sample: z.array(z.record(z.string(), z.unknown())).max(3).default([]),
  term: z.string().default(''),
  description: z.string().default(''),
  tags: z.array(z.string()).max(20).default([]),
  synonyms: z.array(z.string().max(100)).max(30).default([]),
  semanticColumns: z.array(semanticColumnSchema).default([]),
  confidence: z.number().int().min(0).max(100).default(0),
  confidenceReason: z.string().default(''),
  temporary: z.boolean().default(false),
  ignored: z.boolean().default(false),
  ignoredOverride: z.boolean().optional(),
  editedAt: timestampSchema.optional(),
  fingerprint: z.string(),
  semanticFingerprint: z.string().default(''),
  modelProvider: z.string().optional(),
  modelName: z.string().optional(),
  modelReasoningEffort: z.string().optional(),
  modelAnalyzedAt: timestampSchema.optional(),
  modelStatus: z.enum(['heuristic', 'ai', 'failed']).default('heuristic'),
  modelPromptVersion: z.string().default('v1'),
  profiledAt: timestampSchema,
})
export type MetadataProfile = z.infer<typeof metadataProfileSchema>

export const metricAggregationSchema = z.enum(['count', 'sum', 'avg', 'min', 'max', 'formula'])
export type MetricAggregation = z.infer<typeof metricAggregationSchema>

export const metricDefinitionSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  profileId: z.string().min(1),
  name: z.string().min(1).max(120),
  term: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  aggregation: metricAggregationSchema,
  columnName: z.string().max(255).default(''),
  expression: z.string().max(2000),
  unit: z.string().max(50).default(''),
  tags: z.array(z.string().max(50)).max(20).default([]),
  enabled: z.boolean().default(true),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})
export type MetricDefinition = z.infer<typeof metricDefinitionSchema>

export const metadataChangeSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  profileId: z.string().min(1),
  action: z.enum(['create', 'update', 'scan', 'model']),
  summary: z.string().max(500),
  before: z.record(z.string(), z.unknown()).optional(),
  after: z.record(z.string(), z.unknown()).optional(),
  changedAt: timestampSchema,
})
export type MetadataChange = z.infer<typeof metadataChangeSchema>

export type MetadataChangeSummary = Pick<MetadataChange, 'id' | 'sourceId' | 'profileId' | 'action' | 'summary' | 'changedAt'>

export interface MetadataChangePage {
  items: MetadataChangeSummary[]
  offset: number
  limit: number
  total: number
  hasMore: boolean
}

export interface MetricSuggestion {
  profileId: string
  name: string
  term: string
  description: string
  aggregation: MetricAggregation
  columnName: string
  expression: string
  unit: string
  reason: string
}

export interface SqlQueryResult {
  columns: string[]
  rows: Array<Record<string, unknown>>
  rowCount: number
  truncated: boolean
  durationMs: number
}

export const profileJobSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  status: z.enum(['queued', 'running', 'completed', 'cancelled', 'failed']),
  mode: z.enum(['incremental', 'rebuild-ai', 'full']).default('incremental'),
  total: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  currentObject: z.string().optional(),
  error: z.string().optional(),
  startedAt: timestampSchema,
  updatedAt: timestampSchema,
  finishedAt: timestampSchema.optional(),
  modelProvider: z.string().optional(),
  modelName: z.string().optional(),
})
export type ProfileJob = z.infer<typeof profileJobSchema>

export interface DataSourceView extends Omit<DataSourceDefinition, 'credentialRef'> {
  credentialConfigured: boolean
  latestJob?: ProfileJob
  profileCount: number
  aiProfileCount: number
}

export interface ApiDefinitionView extends Omit<ApiDefinition, 'auth'> {
  auth: ApiAuthView
  toolName: string
}

export interface SaveDataSourceInput {
  id?: string
  name: string
  type: DatabaseType
  host: string
  port: number
  database: string
  username: string
  secret?: string
  schemaInclude?: string[]
  tls?: boolean
  sampleRows?: number
  aiEnrichment?: boolean
  enabled?: boolean
}

export interface SaveApiDefinitionInput {
  id?: string
  name: string
  slug: string
  description: string
  method: ApiMethod
  baseUrl: string
  pathTemplate: string
  parameters?: ApiParameter[]
  auth: Omit<ApiAuth, 'credentialRef'>
  secret?: string
  timeoutMs?: number
  maxResponseBytes?: number
  responsePointer?: string
  allowPrivateNetwork?: boolean
  enabled?: boolean
}

export interface ApiExecutionResult {
  status: number
  contentType: string
  body: unknown
  truncated: boolean
  durationMs: number
}
