import { describe, expect, it } from 'vitest'
import { metadataYaml, recommendMetrics } from '../src/host/metadata/governance.js'
import { validateReadOnlySql } from '../src/host/datasource/provider.js'
import { ConnectStore } from '../src/host/store.js'
import { MetadataProfiler } from '../src/host/metadata/profiler.js'
import type { DataSourceDefinition, MetadataChange, MetadataProfile, ProfileJob } from '../src/types.js'

const sourceId = '11111111-1111-4111-8111-111111111111'
const orders = profile('orders', '订单', [column('id', 'bigint', true), column('amount', 'decimal')])
const users = profile('users', '用户', [column('id', 'bigint', true), column('name', 'varchar')])

describe('metadata governance', () => {
  it('recommends count and numeric metrics and exports yaml', () => {
    const metrics = recommendMetrics([orders], sourceId, [])
    expect(metrics.some(metric => metric.aggregation === 'count')).toBe(true)
    expect(metrics.some(metric => metric.columnName === 'amount')).toBe(true)
    const yaml = metadataYaml([orders], [], sourceId)
    expect(yaml).toContain('tables:')
    expect(yaml).toContain('orders')
  })

  it('rejects non-read-only SQL', () => {
    expect(validateReadOnlySql('SELECT * FROM orders')).toBe('SELECT * FROM orders')
    expect(() => validateReadOnlySql('UPDATE orders SET amount = 0')).toThrow()
    expect(() => validateReadOnlySql('SELECT * FROM orders; DROP TABLE users')).toThrow()
  })

  it('returns bounded metadata change pages in reverse chronological order', () => {
    const changes = Array.from({ length: 25 }, (_, index): MetadataChange => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      sourceId,
      profileId: orders.id,
      action: 'update',
      summary: `change ${index}`,
      changedAt: index,
    }))
    const domain = { table: () => ({ entries: () => changes.map(change => [change.id, change]) }) }
    const store = new ConnectStore({} as never, domain as never)
    const first = store.changePage(sourceId, undefined, 0, 20)
    const second = store.changePage(sourceId, undefined, 20, 20)
    expect(first.items).toHaveLength(20)
    expect(first.items[0]?.summary).toBe('change 24')
    expect(first).toMatchObject({ total: 25, hasMore: true })
    expect(second.items).toHaveLength(5)
    expect(second).toMatchObject({ total: 25, hasMore: false })
  })

  it('hides legacy cancelled jobs from data source status', async () => {
    const source: DataSourceDefinition = {
      id: sourceId,
      name: 'Warehouse',
      type: 'postgresql',
      host: '127.0.0.1',
      port: 5432,
      database: 'warehouse',
      username: 'reader',
      credentialRef: 'dsh-connect/source',
      schemaInclude: [],
      tls: false,
      sampleRows: 0,
      aiEnrichment: false,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }
    const cancelledJob: ProfileJob = {
      id: '22222222-2222-4222-8222-222222222222',
      sourceId,
      status: 'cancelled',
      mode: 'incremental',
      total: 10,
      processed: 3,
      startedAt: 2,
      updatedAt: 3,
      finishedAt: 3,
    }
    const tables = new Map<string, Map<string, unknown>>([
      ['data_sources', new Map([[source.id, source]])],
      ['metadata_profiles', new Map([[orders.id, orders]])],
      ['profile_jobs', new Map([[cancelledJob.id, cancelledJob]])],
    ])
    const domain = {
      table(name: string) {
        const table = tables.get(name) ?? new Map<string, unknown>()
        return {
          entries: () => table.entries(),
          get: (id: string) => table.get(id),
          put: async (id: string, value: unknown) => { table.set(id, value) },
          delete: async (id: string) => table.delete(id),
        }
      },
    }
    const context = { credentials: { describe: async () => ({ configured: true }) } }
    const store = new ConnectStore(context as never, domain as never)

    const views = await store.dataSourceViews()

    expect(views[0]).toMatchObject({ id: sourceId, profileCount: 1 })
    expect(views[0]?.latestJob).toBeUndefined()
    expect(store.jobs(sourceId)).toHaveLength(0)
  })

  it('removes an unfinished scan job when it is stopped', async () => {
    const runningJob: ProfileJob = {
      id: '33333333-3333-4333-8333-333333333333',
      sourceId,
      status: 'running',
      mode: 'incremental',
      total: 10,
      processed: 4,
      startedAt: 2,
      updatedAt: 3,
    }
    const jobs = new Map<string, unknown>([[runningJob.id, runningJob]])
    const domain = {
      table(name: string) {
        const table = name === 'profile_jobs' ? jobs : new Map<string, unknown>()
        return {
          entries: () => table.entries(),
          get: (id: string) => table.get(id),
          put: async (id: string, value: unknown) => { table.set(id, value) },
          delete: async (id: string) => table.delete(id),
        }
      },
    }
    const store = new ConnectStore({} as never, domain as never)
    const profiler = new MetadataProfiler({} as never, store)

    await expect(profiler.cancel(sourceId)).resolves.toEqual({ stopped: true, processed: 4, total: 10 })
    expect(store.jobs(sourceId)).toHaveLength(0)
  })
})

function profile(name: string, term: string, columns: MetadataProfile['columns']): MetadataProfile {
  return {
    id: `${sourceId}:public:${name}`,
    sourceId,
    schemaName: 'public',
    objectName: name,
    objectType: 'table',
    ddl: `CREATE TABLE ${name} (...)`,
    columns,
    sample: [],
    term,
    description: term,
    tags: [],
    synonyms: [],
    semanticColumns: [],
    confidence: 90,
    confidenceReason: '',
    temporary: false,
    ignored: false,
    fingerprint: name,
    semanticFingerprint: name,
    modelStatus: 'heuristic',
    modelPromptVersion: 'v3',
    profiledAt: 1,
  }
}

function column(name: string, type: string, primaryKey = false): MetadataProfile['columns'][number] {
  return { name, type, nullable: !primaryKey, primaryKey }
}
