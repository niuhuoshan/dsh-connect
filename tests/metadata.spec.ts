import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { sanitizeRows } from '../src/host/datasource/provider.js'
import { MetadataEnricher } from '../src/host/metadata/enricher.js'

describe('metadata recognition', () => {
  it('redacts sensitive fields and bounds sample values', () => {
    const rows = sanitizeRows([{
      id: 1,
      email: 'alice@example.com',
      api_key: 'secret',
      payload: 'x'.repeat(240),
      created_at: new Date('2026-01-02T03:04:05.000Z'),
    }, { id: 2 }], 1)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 1, email: '[REDACTED]', api_key: '[REDACTED]', created_at: '2026-01-02T03:04:05.000Z' })
    expect(String(rows[0]?.payload)).toHaveLength(203)
  })

  it('recognizes temporary objects deterministically without an LLM', async () => {
    const enricher = new MetadataEnricher({} as Context)
    const profile = await enricher.enrich({
      schemaName: 'public',
      objectName: 'tmp_order_cache',
      objectType: 'table',
      ddl: 'CREATE TABLE tmp_order_cache (order_id bigint)',
      columns: [{ name: 'order_id', type: 'bigint', nullable: false, primaryKey: false }],
      sample: [],
    }, false)
    expect(profile.temporary).toBe(true)
    expect(profile.tags).toContain('temporary')
    expect(profile.semanticColumns[0]?.term).toBe('order id')
    expect(profile.confidence).toBeLessThan(60)
  })

  it('does not send stored sample rows to the DSH model', async () => {
    let request: GenerateOptions | undefined
    const enricher = new MetadataEnricher(aiContext(options => { request = options }))
    await enricher.enrich(discovered([{ account_name: 'sensitive customer' }]), true, undefined, {
      provider: 'deepseek-official', model: 'deepseek-v4', reasoningEffort: 'high',
    })
    const text = request?.messages[0]?.content[0]
    expect(text?.type).toBe('text')
    if (text?.type !== 'text') throw new Error('expected text metadata request')
    expect(text.text).not.toContain('sample')
    expect(text.text).not.toContain('sensitive customer')
  })

  it('records the model route snapshotted for an AI build', async () => {
    const enricher = new MetadataEnricher(aiContext(() => {}))
    const profile = await enricher.enrich(discovered([]), true, undefined, {
      provider: 'deepseek-official', model: 'deepseek-v4', reasoningEffort: 'high',
    })
    expect(profile).toMatchObject({
      modelProvider: 'deepseek-official',
      modelName: 'deepseek-v4',
      modelReasoningEffort: 'high',
      modelStatus: 'ai',
    })
    expect(profile.modelAnalyzedAt).toEqual(expect.any(Number))
  })

  it('keeps foreign keys and identifier-like names as identifier fields', async () => {
    const response = {
      term: 'Orders', description: 'Customer orders', tags: ['transaction'], synonyms: [],
      columns: [{ name: 'customer_id', term: 'Customer', description: 'Customer category', synonyms: [], enums: { active: 1 }, role: 'dimension' }],
      confidence: 0.926, confidenceReason: 'Semantic metadata available', temporary: false,
    }
    const enricher = new MetadataEnricher(aiContext(() => {}, response))
    const profile = await enricher.enrich({
      schemaName: 'public', objectName: 'orders', objectType: 'table', ddl: 'CREATE TABLE orders (customer_id bigint)',
      columns: [{ name: 'customer_id', type: 'bigint', nullable: false, primaryKey: false, references: { schemaName: 'public', objectName: 'customers', columnName: 'id' } }],
      sample: [],
    }, true)
    expect(profile.modelStatus).toBe('ai')
    expect(profile.confidence).toBe(93)
    expect(profile.semanticColumns[0]).toMatchObject({ role: 'identifier', enums: ['active: 1'] })
  })
})

function discovered(sample: Array<Record<string, unknown>>) {
  return {
    schemaName: 'public',
    objectName: 'orders',
    objectType: 'table' as const,
    ddl: 'CREATE TABLE orders (id bigint)',
    columns: [{ name: 'id', type: 'bigint', nullable: false, primaryKey: true }],
    sample,
  }
}

function aiContext(capture: (options: GenerateOptions) => void, modelResponse: unknown = {
    term: 'Orders', description: 'Customer orders', tags: ['transaction'],
    columns: [{ name: 'id', term: 'Order ID', description: 'Primary identifier' }],
    confidence: 92, confidenceReason: 'Clear table and key names', temporary: false,
  }): Context {
  const response = JSON.stringify(modelResponse)
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: response },
    { type: 'block-end', index: 0, block: { type: 'text', text: response } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  return {
    get(name: string) {
      if (name === 'llm') return {
        async *stream(options: GenerateOptions) {
          capture(options)
          yield *chunks
        },
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fallback', model: 'fallback' }) }
      return undefined
    },
  } as unknown as Context
}
