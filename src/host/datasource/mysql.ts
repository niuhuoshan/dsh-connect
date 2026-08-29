import mysql from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2/promise'
import type { DataSourceDefinition, PhysicalColumn } from '../../types.js'
import type { DataSourceProvider, DiscoveredObject } from './provider.js'
import { queryLimit, queryResult, sanitizeRows, throwIfAborted, validateReadOnlySql } from './provider.js'

interface TableRow extends RowDataPacket {
  TABLE_SCHEMA: string
  TABLE_NAME: string
  TABLE_TYPE: string
  ENGINE: string | null
  TABLE_COMMENT: string | null
}

interface ColumnRow extends RowDataPacket {
  TABLE_SCHEMA: string
  TABLE_NAME: string
  COLUMN_NAME: string
  COLUMN_TYPE: string
  IS_NULLABLE: string
  COLUMN_DEFAULT: unknown
  COLUMN_COMMENT: string | null
  COLUMN_KEY: string
}

interface ForeignKeyRow extends RowDataPacket {
  TABLE_SCHEMA: string
  TABLE_NAME: string
  COLUMN_NAME: string
  REFERENCED_TABLE_SCHEMA: string
  REFERENCED_TABLE_NAME: string
  REFERENCED_COLUMN_NAME: string
}

export class MysqlProvider implements DataSourceProvider {
  async test(source: DataSourceDefinition, password: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const connection = await connect(source, password)
    try {
      await connection.query('SELECT 1')
      throwIfAborted(signal)
    } finally {
      await connection.end()
    }
  }

  async discover(source: DataSourceDefinition, password: string, signal?: AbortSignal): Promise<DiscoveredObject[]> {
    const connection = await connect(source, password)
    try {
      const schemas = source.schemaInclude.length > 0 ? source.schemaInclude : [source.database]
      const placeholders = schemas.map(() => '?').join(', ')
      const [tables] = await connection.query<TableRow[]>(
        `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_COMMENT
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA IN (${placeholders})
         ORDER BY TABLE_SCHEMA, TABLE_NAME`,
        schemas,
      )
      const [columns] = await connection.query<ColumnRow[]>(
        `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
                COLUMN_DEFAULT, COLUMN_COMMENT, COLUMN_KEY
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA IN (${placeholders})
         ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
        schemas,
      )
      const [foreignKeys] = await connection.query<ForeignKeyRow[]>(
        `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA,
                REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA IN (${placeholders})
           AND REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
        schemas,
      )
      const columnsByObject = groupColumns(columns, foreignKeys)
      const result: DiscoveredObject[] = []
      for (const table of tables) {
        throwIfAborted(signal)
        const qualified = `${quote(table.TABLE_SCHEMA)}.${quote(table.TABLE_NAME)}`
        const [ddlRows] = await connection.query<RowDataPacket[]>(`SHOW CREATE ${table.TABLE_TYPE === 'VIEW' ? 'VIEW' : 'TABLE'} ${qualified}`)
        const ddlRecord = ddlRows[0]
        const ddl = ddlRecord === undefined ? '' : String(ddlRecord['Create Table'] ?? ddlRecord['Create View'] ?? '')
        let sample: Array<Record<string, unknown>> = []
        if (source.sampleRows > 0) {
          const [rows] = await connection.query<RowDataPacket[]>(`SELECT * FROM ${qualified} LIMIT ${source.sampleRows}`)
          sample = sanitizeRows(rows, source.sampleRows)
        }
        result.push({
          schemaName: table.TABLE_SCHEMA,
          objectName: table.TABLE_NAME,
          objectType: table.TABLE_TYPE === 'VIEW' ? 'view' : 'table',
          ...(table.ENGINE === null ? {} : { engine: table.ENGINE }),
          ...(table.TABLE_COMMENT ? { comment: table.TABLE_COMMENT } : {}),
          ddl,
          columns: columnsByObject.get(`${table.TABLE_SCHEMA}\0${table.TABLE_NAME}`) ?? [],
          sample,
        })
      }
      return result
    } finally {
      await connection.end()
    }
  }

  async query(source: DataSourceDefinition, password: string, rawSql: string, limit: number, signal?: AbortSignal) {
    const sql = validateReadOnlySql(rawSql)
    const bounded = queryLimit(limit)
    const startedAt = Date.now()
    throwIfAborted(signal)
    const connection = await connect(source, password)
    try {
      await connection.query('START TRANSACTION READ ONLY')
      const [rows, fields] = await connection.query<RowDataPacket[]>({ sql: `SELECT * FROM (${sql}) AS dsh_connect_query LIMIT ${bounded + 1}`, timeout: 30_000 })
      throwIfAborted(signal)
      const columns = (fields as Array<{ name: string }> | undefined)?.map(field => field.name) ?? Object.keys(rows[0] ?? {})
      return queryResult(columns, rows, bounded, startedAt)
    } finally {
      await connection.rollback().catch(() => {})
      await connection.end()
    }
  }
}

function connect(source: DataSourceDefinition, password: string) {
  return mysql.createConnection({
    host: source.host,
    port: source.port,
    user: source.username,
    password,
    database: source.database,
    connectTimeout: 10_000,
    ...(source.tls ? { ssl: {} } : {}),
  })
}

function groupColumns(rows: ColumnRow[], foreignKeys: ForeignKeyRow[]): Map<string, PhysicalColumn[]> {
  const result = new Map<string, PhysicalColumn[]>()
  const references = new Map(foreignKeys.map(row => [
    `${row.TABLE_SCHEMA}\0${row.TABLE_NAME}\0${row.COLUMN_NAME}`,
    { schemaName: row.REFERENCED_TABLE_SCHEMA, objectName: row.REFERENCED_TABLE_NAME, columnName: row.REFERENCED_COLUMN_NAME },
  ]))
  for (const row of rows) {
    const key = `${row.TABLE_SCHEMA}\0${row.TABLE_NAME}`
    const list = result.get(key) ?? []
    list.push({
      name: row.COLUMN_NAME,
      type: row.COLUMN_TYPE,
      nullable: row.IS_NULLABLE === 'YES',
      defaultValue: row.COLUMN_DEFAULT === null ? null : String(row.COLUMN_DEFAULT),
      ...(row.COLUMN_COMMENT ? { comment: row.COLUMN_COMMENT } : {}),
      primaryKey: row.COLUMN_KEY === 'PRI',
      ...(references.get(`${row.TABLE_SCHEMA}\0${row.TABLE_NAME}\0${row.COLUMN_NAME}`) === undefined
        ? {}
        : { references: references.get(`${row.TABLE_SCHEMA}\0${row.TABLE_NAME}\0${row.COLUMN_NAME}`) }),
    })
    result.set(key, list)
  }
  return result
}

function quote(value: string): string {
  return `\`${value.replaceAll('`', '``')}\``
}
