import type { DataSourceDefinition, PhysicalColumn, SqlQueryResult } from '../../types.js'

export interface DiscoveredObject {
  schemaName: string
  objectName: string
  objectType: 'table' | 'view'
  engine?: string
  comment?: string
  ddl: string
  columns: PhysicalColumn[]
  sample: Array<Record<string, unknown>>
}

export interface DataSourceProvider {
  test(source: DataSourceDefinition, password: string, signal?: AbortSignal): Promise<void>
  discover(source: DataSourceDefinition, password: string, signal?: AbortSignal): Promise<DiscoveredObject[]>
  query(source: DataSourceDefinition, password: string, sql: string, limit: number, signal?: AbortSignal): Promise<SqlQueryResult>
}

const SENSITIVE_COLUMN = /(?:pass(?:word)?|secret|token|api[_-]?key|authorization|cookie|email|e[-_]?mail|phone|mobile|id[_-]?card|身份证|手机号|邮箱)/i

export function sanitizeRows(rows: unknown[], maxRows: number): Array<Record<string, unknown>> {
  return rows.slice(0, maxRows).map(row => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return { value: sanitizeValue(row) }
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key,
      SENSITIVE_COLUMN.test(key) ? '[REDACTED]' : sanitizeValue(value),
    ]))
  })
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return `[binary:${value.byteLength} bytes]`
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length <= 200 ? text : `${text.slice(0, 200)}...`
}

export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

/** Validate the query before it reaches a database driver. Providers also use a
 * read-only session where supported, but the plugin must reject writes itself. */
export function validateReadOnlySql(rawSql: string): string {
  const sql = rawSql.trim()
  if (sql === '') throw new Error('SQL cannot be empty')
  if (sql.length > 20_000) throw new Error('SQL is limited to 20000 characters')
  if (sql.includes(';') || sql.includes('--') || sql.includes('/*') || sql.includes('*/')) {
    throw new Error('Only one read-only SQL statement is allowed; comments and semicolons are not allowed')
  }
  if (!/^(?:select|with)\b/i.test(sql)) throw new Error('Only SELECT or WITH queries are allowed')
  if (/\b(?:insert|update|delete|drop|alter|create|truncate|grant|revoke|replace|merge|call|set|use|into|outfile|dumpfile)\b/i.test(sql)) {
    throw new Error('The SQL contains a write or session-changing operation')
  }
  return sql
}

export function queryLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 100
  return Math.min(1000, Math.max(1, Math.trunc(value)))
}

export function queryResult(columns: string[], rows: unknown[], limit: number, startedAt: number): SqlQueryResult {
  const truncated = rows.length > limit
  return {
    columns,
    rows: sanitizeRows(rows, limit),
    rowCount: Math.min(rows.length, limit),
    truncated,
    durationMs: Date.now() - startedAt,
  }
}
