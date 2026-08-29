import { createClient } from '@clickhouse/client'
import type { DataSourceDefinition, PhysicalColumn } from '../../types.js'
import type { DataSourceProvider, DiscoveredObject } from './provider.js'
import { queryLimit, queryResult, sanitizeRows, throwIfAborted, validateReadOnlySql } from './provider.js'

interface TableRow {
  database: string
  name: string
  engine: string
  comment: string
  create_table_query: string
  is_temporary: number
}

interface ColumnRow {
  database: string
  table: string
  name: string
  type: string
  default_expression: string
  comment: string
  is_in_primary_key: number
}

export class ClickhouseProvider implements DataSourceProvider {
  async test(source: DataSourceDefinition, password: string, signal?: AbortSignal): Promise<void> {
    const client = connect(source, password)
    try {
      await client.query({ query: 'SELECT 1', format: 'JSONEachRow', ...(signal === undefined ? {} : { abort_signal: signal }) })
    } finally {
      await client.close()
    }
  }

  async discover(source: DataSourceDefinition, password: string, signal?: AbortSignal): Promise<DiscoveredObject[]> {
    const client = connect(source, password)
    try {
      const databases = source.schemaInclude.length > 0 ? source.schemaInclude : [source.database]
      const dbList = databases.map(quoteLiteral).join(', ')
      const tableResult = await client.query({
        query: `SELECT database, name, engine, comment, create_table_query, is_temporary
                FROM system.tables WHERE database IN (${dbList}) ORDER BY database, name`,
        format: 'JSONEachRow',
        ...(signal === undefined ? {} : { abort_signal: signal }),
      })
      const columnResult = await client.query({
        query: `SELECT database, table, name, type, default_expression, comment, is_in_primary_key
                FROM system.columns WHERE database IN (${dbList}) ORDER BY database, table, position`,
        format: 'JSONEachRow',
        ...(signal === undefined ? {} : { abort_signal: signal }),
      })
      const tables = await tableResult.json<TableRow>()
      const columns = await columnResult.json<ColumnRow>()
      const columnsByObject = groupColumns(columns)
      const result: DiscoveredObject[] = []
      for (const table of tables) {
        throwIfAborted(signal)
        let sample: Array<Record<string, unknown>> = []
        if (source.sampleRows > 0) {
          const rows = await client.query({
            query: `SELECT * FROM ${quote(table.database)}.${quote(table.name)} LIMIT ${source.sampleRows}`,
            format: 'JSONEachRow',
            ...(signal === undefined ? {} : { abort_signal: signal }),
          })
          sample = sanitizeRows(await rows.json<Record<string, unknown>>(), source.sampleRows)
        }
        result.push({
          schemaName: table.database,
          objectName: table.name,
          objectType: table.engine === 'View' || table.engine.endsWith('View') ? 'view' : 'table',
          engine: table.engine,
          ...(table.comment ? { comment: table.comment } : {}),
          ddl: table.create_table_query,
          columns: columnsByObject.get(`${table.database}\0${table.name}`) ?? [],
          sample,
        })
      }
      return result
    } finally {
      await client.close()
    }
  }

  async query(source: DataSourceDefinition, password: string, rawSql: string, limit: number, signal?: AbortSignal) {
    const sql = validateReadOnlySql(rawSql)
    const bounded = queryLimit(limit)
    const startedAt = Date.now()
    const client = connect(source, password)
    try {
      const result = await client.query({ query: `SELECT * FROM (${sql}) AS dsh_connect_query LIMIT ${bounded + 1}`, format: 'JSONEachRow', clickhouse_settings: { readonly: '2', max_execution_time: 30 }, ...(signal === undefined ? {} : { abort_signal: signal }) })
      const rows = await result.json<Record<string, unknown>>()
      throwIfAborted(signal)
      return queryResult(Object.keys(rows[0] ?? {}), rows, bounded, startedAt)
    } finally {
      await client.close()
    }
  }
}

function connect(source: DataSourceDefinition, password: string) {
  return createClient({
    url: `${source.tls ? 'https' : 'http'}://${source.host}:${source.port}`,
    username: source.username,
    password,
    database: source.database,
    request_timeout: 30_000,
  })
}

function groupColumns(rows: ColumnRow[]): Map<string, PhysicalColumn[]> {
  const result = new Map<string, PhysicalColumn[]>()
  for (const row of rows) {
    const key = `${row.database}\0${row.table}`
    const list = result.get(key) ?? []
    list.push({
      name: row.name,
      type: row.type,
      nullable: row.type.startsWith('Nullable('),
      defaultValue: row.default_expression === '' ? null : row.default_expression,
      ...(row.comment ? { comment: row.comment } : {}),
      primaryKey: Boolean(row.is_in_primary_key),
    })
    result.set(key, list)
  }
  return result
}

function quote(value: string): string {
  return `\`${value.replaceAll('`', '``')}\``
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}
