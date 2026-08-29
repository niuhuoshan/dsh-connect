import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type { DiscoveredObject } from '../datasource/provider.js'
import type { SemanticColumn } from '../../types.js'

export interface SemanticProfile {
  term: string
  description: string
  tags: string[]
  synonyms: string[]
  semanticColumns: SemanticColumn[]
  confidence: number
  confidenceReason: string
  temporary: boolean
  modelProvider?: string
  modelName?: string
  modelReasoningEffort?: string
  modelAnalyzedAt?: number
  modelStatus: 'heuristic' | 'ai' | 'failed'
}

export const METADATA_MODEL_PROMPT_VERSION = 'v3'

export interface MetadataModelRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

export class MetadataModelOutputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MetadataModelOutputError'
  }
}

const stringList = (maxItems: number, maxLength: number) => z.preprocess(
  value => normalizeStringList(value, maxItems, maxLength),
  z.array(z.string().max(maxLength)).max(maxItems),
)

const semanticProfileSchema = z.object({
  term: z.string().max(100),
  description: z.string().max(500),
  tags: stringList(20, 50),
  synonyms: stringList(30, 100),
  columns: z.array(z.object({
    name: z.string(),
    term: z.string().max(100),
    description: z.string().max(300),
    synonyms: stringList(20, 100),
    enums: stringList(50, 100),
    role: z.enum(['identifier', 'dimension', 'measure', 'time', 'unknown']).default('unknown'),
  })).max(500),
  confidence: z.number().refine(Number.isFinite, 'confidence must be a finite number'),
  confidenceReason: z.string().max(500),
  temporary: z.boolean(),
})

interface DefaultModelLike {
  currentSelection(): MetadataModelRoute
}

interface LlmLike {
  stream(options: Parameters<Context['llm']['stream']>[0]): ReturnType<Context['llm']['stream']>
}

export class MetadataEnricher {
  constructor(private readonly ctx: Context) {}

  async enrich(object: DiscoveredObject, useAi: boolean, signal?: AbortSignal, selectedRoute?: MetadataModelRoute): Promise<SemanticProfile> {
    const fallback = heuristicProfile(object)
    if (!useAi) return fallback
    const llm = this.ctx.get('llm') as LlmLike | undefined
    const defaults = this.ctx.get('agentDefaultModel') as DefaultModelLike | undefined
    if (llm === undefined || defaults === undefined) {
      return { ...fallback, modelStatus: 'failed', confidenceReason: `${fallback.confidenceReason}; DSH model service unavailable` }
    }
    try {
      signal?.throwIfAborted()
      const route = selectedRoute ?? defaults.currentSelection()
      const input = JSON.stringify({
        schema: object.schemaName,
        name: object.objectName,
        type: object.objectType,
        comment: object.comment ?? '',
        ddl: object.ddl.slice(0, 16_000),
        columns: object.columns,
      })
      const messages = [createUserMessage({
        content: [{ type: 'text', text: input }],
        source: { kind: 'plugin', plugin: 'dsh-connect' },
      })]
      const assembler = new BlockAssembler()
      const options = deepFreeze({
        provider: route.provider,
        model: route.model,
        messages,
        system: SYSTEM_PROMPT,
        temperature: 0.1,
        maxTokens: 12_000,
        ...(signal === undefined ? {} : { signal }),
      })
      for await (const chunk of llm.stream(options)) assembler.push(chunk)
      if (assembler.finish.kind !== 'stop') throw new Error(`model stopped with ${assembler.finish.kind}`)
      const text = assembler.blocks()
        .filter((block): block is Extract<(ReturnType<BlockAssembler['blocks']>)[number], { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      let parsed: z.infer<typeof semanticProfileSchema>
      try {
        parsed = semanticProfileSchema.parse(parseJson(text))
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new MetadataModelOutputError(`AI 元数据结果格式无效：${formatIssues(error)}`, { cause: error })
        }
        throw new MetadataModelOutputError('AI 元数据结果不是有效 JSON', { cause: error })
      }
      const knownColumns = new Set(object.columns.map(column => column.name))
      const parsedColumns = new Map(parsed.columns.filter(column => knownColumns.has(column.name)).map(column => [column.name, column]))
      return {
        term: parsed.term,
        description: parsed.description,
        tags: [...new Set(parsed.tags)],
        synonyms: [...new Set(parsed.synonyms)],
        semanticColumns: object.columns.map(column => {
          const semantic = parsedColumns.get(column.name)
          const fallbackColumn = fallback.semanticColumns.find(item => item.name === column.name)
          return {
            name: column.name,
            term: semantic?.term ?? fallbackColumn?.term ?? column.name,
            description: semantic?.description ?? fallbackColumn?.description ?? '',
            synonyms: semantic?.synonyms ?? fallbackColumn?.synonyms ?? [],
            enums: semantic?.enums ?? fallbackColumn?.enums ?? [],
            role: normalizeRole(semantic?.role ?? fallbackColumn?.role ?? 'unknown', column),
          }
        }),
        confidence: normalizeConfidence(parsed.confidence),
        confidenceReason: parsed.confidenceReason,
        temporary: parsed.temporary,
        modelProvider: route.provider,
        modelName: route.model,
        ...(route.reasoningEffort === undefined ? {} : { modelReasoningEffort: route.reasoningEffort }),
        modelAnalyzedAt: Date.now(),
        modelStatus: 'ai',
      }
    } catch (error) {
      if (signal?.aborted) throw error
      return {
        ...fallback,
        modelStatus: 'failed',
        ...(selectedRoute === undefined ? {} : { modelProvider: selectedRoute.provider, modelName: selectedRoute.model, modelAnalyzedAt: Date.now() }),
        confidenceReason: `${fallback.confidenceReason}; AI enrichment failed: ${safeError(error)}`.slice(0, 500),
      }
    }
  }
}

const SYSTEM_PROMPT = `You are a database metadata governance specialist. Infer semantic metadata only from the supplied JSON physical metadata. Never invent rows, metrics, or business rules. Return one JSON object with exactly these fields: term, description, tags, columns, confidence, confidenceReason, temporary, synonyms. columns is an array of {name, term, description, synonyms, enums, role} using only physical column names. role must be one of identifier, dimension, measure, time, unknown. Role rules are strict: primary keys, explicit foreign keys, columns with a references object, and obvious identifiers such as *_id, *_key, *_code, *_uuid, *_no, or comments containing ID/编号/编码/标识 must be identifier, even when they can also be used for filtering. A foreign-key identifier must never be dimension. Use dimension only for descriptive or categorical attributes such as name, status, type, region, or category. Use measure only for numeric amounts, counts, quantities, rates, or scores; use time only for dates and timestamps. Preserve every physical column in the response. confidence may be either a probability from 0 to 1 or a score from 0 to 100; it will be normalized by the host. Return JSON only, without Markdown.`

function heuristicProfile(object: DiscoveredObject): SemanticProfile {
  const temporary = /(?:^|_)(?:tmp|temp|test|bak|backup|stg|stage|cache)(?:_|$)/i.test(object.objectName)
  let confidence = temporary ? 35 : 85
  const reasons: string[] = []
  if (temporary) reasons.push('object name indicates temporary, test, staging, backup, or cache data')
  if (!object.columns.some(column => column.primaryKey)) {
    confidence -= 10
    reasons.push('no primary key was discovered')
  }
  if (!object.comment && object.columns.every(column => !column.comment)) {
    confidence -= 10
    reasons.push('database comments are absent')
  }
  if (object.sample.length === 0) {
    confidence -= 5
    reasons.push('sample data was disabled or unavailable')
  }
  return {
    term: object.comment?.trim() || humanize(object.objectName),
    description: object.comment?.trim() || `${object.objectType} ${object.schemaName}.${object.objectName}`,
    tags: [object.objectType, ...(object.engine ? [object.engine] : []), ...(temporary ? ['temporary'] : [])],
    synonyms: [],
    semanticColumns: object.columns.map(column => ({
      name: column.name,
      term: column.comment?.trim() || humanize(column.name),
      description: column.comment?.trim() || `${column.type}${column.nullable ? ', nullable' : ', required'}`,
      synonyms: [],
      enums: [],
      role: fallbackRole(column),
    })),
    confidence: Math.max(0, confidence),
    confidenceReason: reasons.join('; ') || 'physical metadata is complete',
    temporary,
    modelStatus: 'heuristic',
  }
}

function humanize(value: string): string {
  return value.replaceAll(/[_-]+/g, ' ').replaceAll(/\s+/g, ' ').trim()
}

function normalizeConfidence(value: number): number {
  const score = value >= 0 && value <= 1 ? value * 100 : value
  return Math.max(0, Math.min(100, Math.round(score)))
}

function normalizeStringList(value: unknown, maxItems: number, maxLength: number): string[] {
  const items = Array.isArray(value)
    ? value
    : value !== null && typeof value === 'object'
      ? Object.entries(value).map(([key, item]) => `${key}: ${String(item)}`)
      : value === undefined || value === null || value === '' ? [] : [value]
  return [...new Set(items.map(item => String(item).trim().slice(0, maxLength)).filter(Boolean))].slice(0, maxItems)
}

function normalizeRole(role: SemanticColumn['role'], column: DiscoveredObject['columns'][number]): SemanticColumn['role'] {
  if (column.primaryKey || column.references !== undefined || isIdentifierName(column.name) || isIdentifierComment(column.comment)) return 'identifier'
  return role
}

function fallbackRole(column: DiscoveredObject['columns'][number]): SemanticColumn['role'] {
  if (column.primaryKey || column.references !== undefined || isIdentifierName(column.name) || isIdentifierComment(column.comment)) return 'identifier'
  if (/(?:date|time|timestamp|year|month|day)(?:$|_)/i.test(column.name) || /(?:date|time|timestamp)/i.test(column.type)) return 'time'
  if (/(?:amount|price|cost|total|balance|quantity|count|num|score|points|rate|ratio)(?:$|_)/i.test(column.name) && /(?:int|decimal|numeric|float|double|real)/i.test(column.type)) return 'measure'
  if (/(?:name|status|state|type|category|region|country|city|flag)(?:$|_)/i.test(column.name)) return 'dimension'
  return 'unknown'
}

function isIdentifierName(name: string): boolean {
  return /(?:^|_)(?:id|key|code|uuid|no)(?:$|_)/i.test(name)
}

function isIdentifierComment(comment: string | undefined): boolean {
  return comment !== undefined && /(?:\bid\b|\bidentifier\b|编号|编码|标识)/i.test(comment)
}

function formatIssues(error: z.ZodError): string {
  return error.issues.slice(0, 3).map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')
}

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('model returned no JSON object')
  return JSON.parse(trimmed.slice(start, end + 1))
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/[\r\n]+/g, ' ').slice(0, 160)
}
