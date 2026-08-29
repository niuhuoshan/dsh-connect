import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConnectStore } from '../store.js'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { providerFor } from '../datasource/index.js'
import { metadataYaml } from './governance.js'
import { queryLimit } from '../datasource/provider.js'

const jsonOutput = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

export function registerMetadataTools(ctx: Context, store: ConnectStore): Array<() => void> {
  return [
    ctx.tools.register(defineTool({
      name: 'dsh_connect_list_data_sources',
      description: 'List configured data sources that have metadata available. This exposes connection names and metadata counts, never credentials or host addresses.',
      parameters: {},
      output: jsonOutput,
      isConcurrencySafe: () => true,
      async execute() {
        const views = await store.dataSourceViews()
        return views.filter(source => source.enabled).map(source => ({
          id: source.id,
          name: source.name,
          type: source.type,
          database: source.database,
          profileCount: source.profileCount,
          lastScanStatus: source.latestJob?.status ?? 'never-scanned',
        }))
      },
      presentCall: () => ({ card: 'generic', title: 'List data sources', kind: 'read' }),
    })),
    ctx.tools.register(defineTool({
      name: 'dsh_connect_search_metadata',
      description: 'Search recognized table, view, and column metadata. Use this to understand available data structures; it does not query business rows or execute SQL.',
      parameters: {
        query: { type: 'string', required: true, description: 'Name, semantic term, description, tag, or column text to search.' },
        sourceId: { type: 'string', description: 'Optional exact data source id from dsh_connect_list_data_sources.' },
        limit: { type: 'integer', description: 'Optional result limit from 1 to 20. Default 10.' },
      },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      execute(args) {
        const query = args.query.trim().toLocaleLowerCase()
        if (query === '') throw new Error('query must not be blank')
        const limit = Math.min(20, Math.max(1, args.limit ?? 10))
        const results = store.profiles(args.sourceId).filter(profile => {
          const haystack = [
            profile.schemaName,
            profile.objectName,
            profile.term,
            profile.description,
            profile.tags.join(' '),
            profile.columns.map(column => `${column.name} ${column.comment ?? ''}`).join(' '),
            profile.semanticColumns.map(column => `${column.name} ${column.term} ${column.description}`).join(' '),
          ].join(' ').toLocaleLowerCase()
          return haystack.includes(query)
        }).slice(0, limit)
        return Promise.resolve(results.map(profile => ({
          id: profile.id,
          sourceId: profile.sourceId,
          schema: profile.schemaName,
          name: profile.objectName,
          type: profile.objectType,
          term: profile.term,
          description: profile.description,
          tags: profile.tags,
          confidence: profile.confidence,
          temporary: profile.temporary,
          ignored: profile.ignored,
          columns: profile.semanticColumns.map(column => ({ name: column.name, term: column.term })),
        })))
      },
      presentCall: args => ({ card: 'generic', title: `Search metadata: ${args.query}`, kind: 'search' }),
    })),
    ctx.tools.register(defineTool({
      name: 'dsh_connect_get_table_metadata',
      description: 'Read one recognized table or view metadata profile by the exact profile id returned by dsh_connect_search_metadata. It returns schema and semantic metadata, never sample rows.',
      parameters: {
        profileId: { type: 'string', required: true, description: 'Exact metadata profile id.' },
      },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      execute(args) {
        const profile = store.profile(args.profileId)
        if (profile === undefined) throw new Error('Metadata profile not found')
        return Promise.resolve({
          id: profile.id,
          sourceId: profile.sourceId,
          schema: profile.schemaName,
          name: profile.objectName,
          type: profile.objectType,
          ...(profile.engine === undefined ? {} : { engine: profile.engine }),
          ...(profile.comment === undefined ? {} : { databaseComment: profile.comment }),
          ddl: profile.ddl,
          columns: profile.columns.map(column => {
            const semantic = profile.semanticColumns.find(item => item.name === column.name)
            return {
              name: column.name,
              type: column.type,
              nullable: column.nullable,
              primaryKey: column.primaryKey,
              ...(column.defaultValue === undefined ? {} : { defaultValue: column.defaultValue }),
              ...(column.comment === undefined ? {} : { comment: column.comment }),
              ...(column.references === undefined ? {} : { references: column.references }),
              ...(semantic === undefined ? {} : { semantic }),
            }
          }),
          term: profile.term,
          description: profile.description,
          tags: profile.tags,
          confidence: profile.confidence,
          confidenceReason: profile.confidenceReason,
          temporary: profile.temporary,
          ignored: profile.ignored,
          profiledAt: profile.profiledAt,
        })
      },
      presentCall: () => ({ card: 'generic', title: 'Read table metadata', kind: 'read' }),
    })),
    ctx.tools.register(defineTool({
      name: 'dsh_connect_query_data_source',
      description: 'Execute a bounded read-only SELECT or WITH query against a configured data source. Never use this for writes or schema changes.',
      parameters: {
        sourceId: { type: 'string', required: true, description: 'Exact data source id.' },
        sql: { type: 'string', required: true, description: 'One SELECT or WITH query. No semicolon or comments.' },
        limit: { type: 'integer', description: 'Maximum rows, 1 to 1000. Default 100.' },
      },
      output: jsonOutput,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const source = store.dataSource(args.sourceId)
        if (source === undefined) throw new Error('Data source not found')
        if (!source.enabled) throw new Error('Data source is disabled')
        const password = await ctx.credentials.resolve(credentialRef(source.credentialRef))
        if (password === undefined) throw new Error('Database credential is not configured')
        return JSON.parse(JSON.stringify(await providerFor(source.type).query(source, password.value, args.sql, queryLimit(args.limit), exec.signal)))
      },
      presentCall: args => ({ card: 'generic', title: `Query ${args.sourceId}`, kind: 'read' }),
    })),
    ctx.tools.register(defineTool({
      name: 'dsh_connect_export_metadata_yaml',
      description: 'Export recognized metadata and metrics as YAML text for review or version control.',
      parameters: { sourceId: { type: 'string', required: true } },
      output: { schema: { type: 'string' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }] },
      isConcurrencySafe: () => true,
      async execute(args) { return metadataYaml(store.profiles(args.sourceId), store.metrics(args.sourceId), args.sourceId) },
      presentCall: () => ({ card: 'generic', title: 'Export metadata YAML', kind: 'read' }),
    })),
  ]
}
