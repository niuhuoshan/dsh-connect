import { Client } from 'pg'
import type { QueryConfig, QueryResultRow } from 'pg'
import type { DataSourceDefinition, PhysicalColumn } from '../../types.js'
import type { DataSourceProvider, DiscoveredObject } from './provider.js'
import { queryLimit, queryResult, sanitizeRows, throwIfAborted, validateReadOnlySql } from './provider.js'

interface TableRow {
  table_schema: string
  table_name: string
  table_type: string
  table_comment: string | null
}

interface ColumnRow {
  table_schema: string
  table_name: string
  column_name: string
  data_type: string
  udt_name: string
  is_nullable: string
  column_default: string | null
  column_comment: string | null
  primary_key: boolean
}

interface ForeignKeyRow {
  table_schema: string
  table_name: string
  column_name: string
  referenced_table_schema: string
  referenced_table_name: string
  referenced_column_name: string
}

export class PostgresqlProvider implements DataSourceProvider {
  async test(source: DataSourceDefinition, password: string, signal?: AbortSignal): Promise<void> {
    const client = await connect(source, password)
    try {
      await queryRows(client, 'SELECT 1', [], signal)
    } finally {
      await client.end()
    }
  }

  async discover(source: DataSourceDefinition, password: string, signal?: AbortSignal): Promise<DiscoveredObject[]> {
    const client = await connect(source, password)
    try {
      const schemas = source.schemaInclude.length > 0 ? source.schemaInclude : ['public']
      const tables = await queryRows<TableRow>(client, `SELECT t.table_schema, t.table_name, t.table_type,
                      obj_description((quote_ident(t.table_schema) || '.' || quote_ident(t.table_name))::regclass) AS table_comment
               FROM information_schema.tables t
               WHERE t.table_schema = ANY($1::text[])
               ORDER BY t.table_schema, t.table_name`, [schemas], signal)
      const columns = await queryRows<ColumnRow>(client, `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.udt_name,
                      c.is_nullable, c.column_default,
                      col_description((quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass, c.ordinal_position) AS column_comment,
                      EXISTS (
                        SELECT 1 FROM information_schema.table_constraints tc
                        JOIN information_schema.key_column_usage kcu
                          ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
                        WHERE tc.constraint_type = 'PRIMARY KEY'
                          AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name
                          AND kcu.column_name = c.column_name
                      ) AS primary_key
               FROM information_schema.columns c
               WHERE c.table_schema = ANY($1::text[])
               ORDER BY c.table_schema, c.table_name, c.ordinal_position`, [schemas], signal)
      const foreignKeys = await queryRows<ForeignKeyRow>(client, `SELECT fk.table_schema, fk.table_name, fk.column_name,
                      pk.table_schema AS referenced_table_schema,
                      pk.table_name AS referenced_table_name,
                      pk.column_name AS referenced_column_name
               FROM information_schema.referential_constraints rc
               JOIN information_schema.key_column_usage fk
                 ON fk.constraint_catalog = rc.constraint_catalog
                AND fk.constraint_schema = rc.constraint_schema
                AND fk.constraint_name = rc.constraint_name
               JOIN information_schema.key_column_usage pk
                 ON pk.constraint_catalog = rc.unique_constraint_catalog
                AND pk.constraint_schema = rc.unique_constraint_schema
                AND pk.constraint_name = rc.unique_constraint_name
                AND pk.ordinal_position = fk.position_in_unique_constraint
               WHERE fk.table_schema = ANY($1::text[])
               ORDER BY fk.table_schema, fk.table_name, fk.ordinal_position`, [schemas], signal)
      const columnsByObject = groupColumns(columns, foreignKeys)
      const result: DiscoveredObject[] = []
      for (const table of tables) {
        throwIfAborted(signal)
        const objectColumns = columnsByObject.get(`${table.table_schema}\0${table.table_name}`) ?? []
        const qualified = `${quote(table.table_schema)}.${quote(table.table_name)}`
        let sample: Array<Record<string, unknown>> = []
        if (source.sampleRows > 0) {
          const rows = await queryRows<Record<string, unknown>>(client, `SELECT * FROM ${qualified} LIMIT ${source.sampleRows}`, [], signal)
          sample = sanitizeRows(rows, source.sampleRows)
        }
        result.push({
          schemaName: table.table_schema,
          objectName: table.table_name,
          objectType: table.table_type === 'VIEW' ? 'view' : 'table',
          ...(table.table_comment ? { comment: table.table_comment } : {}),
          ddl: buildDdl(table.table_schema, table.table_name, objectColumns, table.table_type === 'VIEW'),
          columns: objectColumns,
          sample,
        })
      }
      return result
    } finally {
      await client.end()
    }
  }

  async query(source: DataSourceDefinition, password: string, rawSql: string, limit: number, signal?: AbortSignal) {
    const sql = validateReadOnlySql(rawSql)
    const bounded = queryLimit(limit)
    const startedAt = Date.now()
    const client = await connect(source, password)
    try {
      const result = await client.query<QueryResultRow>({ text: `SELECT * FROM (${sql}) AS dsh_connect_query LIMIT $1`, values: [bounded + 1], ...(signal === undefined ? {} : { signal }) } as QueryConfig<unknown[]>)
      throwIfAborted(signal)
      return queryResult(result.fields.map(field => field.name), result.rows, bounded, startedAt)
    } finally {
      await client.end()
    }
  }
}

async function queryRows<T extends QueryResultRow>(
  client: Client,
  text: string,
  values: unknown[],
  signal?: AbortSignal,
): Promise<T[]> {
  throwIfAborted(signal)
  const config = {
    text,
    ...(values.length === 0 ? {} : { values }),
    ...(signal === undefined ? {} : { signal }),
  } as QueryConfig<unknown[]>
  const result = await client.query<T>(config)
  throwIfAborted(signal)
  return result.rows
}

async function connect(source: DataSourceDefinition, password: string): Promise<Client> {
  const client = new Client({
    host: source.host,
    port: source.port,
    user: source.username,
    password,
    database: source.database,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    ssl: source.tls ? { rejectUnauthorized: true } : false,
  })
  await client.connect()
  await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
  return client
}

function groupColumns(rows: ColumnRow[], foreignKeys: ForeignKeyRow[]): Map<string, PhysicalColumn[]> {
  const result = new Map<string, PhysicalColumn[]>()
  const references = new Map(foreignKeys.map(row => [
    `${row.table_schema}\0${row.table_name}\0${row.column_name}`,
    { schemaName: row.referenced_table_schema, objectName: row.referenced_table_name, columnName: row.referenced_column_name },
  ]))
  for (const row of rows) {
    const key = `${row.table_schema}\0${row.table_name}`
    const list = result.get(key) ?? []
    list.push({
      name: row.column_name,
      type: row.data_type === 'USER-DEFINED' ? row.udt_name : row.data_type,
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      ...(row.column_comment ? { comment: row.column_comment } : {}),
      primaryKey: row.primary_key,
      ...(references.get(`${row.table_schema}\0${row.table_name}\0${row.column_name}`) === undefined
        ? {}
        : { references: references.get(`${row.table_schema}\0${row.table_name}\0${row.column_name}`) }),
    })
    result.set(key, list)
  }
  return result
}

function buildDdl(schema: string, table: string, columns: PhysicalColumn[], view: boolean): string {
  if (view) return `CREATE VIEW ${quote(schema)}.${quote(table)} AS /* definition not exposed by information_schema */;`
  const definitions = columns.map(column => {
    const suffix = [column.nullable ? '' : 'NOT NULL', column.defaultValue == null ? '' : `DEFAULT ${column.defaultValue}`]
      .filter(Boolean).join(' ')
    return `  ${quote(column.name)} ${column.type}${suffix === '' ? '' : ` ${suffix}`}`
  })
  const primary = columns.filter(column => column.primaryKey).map(column => quote(column.name))
  if (primary.length > 0) definitions.push(`  PRIMARY KEY (${primary.join(', ')})`)
  for (const column of columns) {
    if (column.references !== undefined) {
      definitions.push(`  FOREIGN KEY (${quote(column.name)}) REFERENCES ${quote(column.references.schemaName)}.${quote(column.references.objectName)} (${quote(column.references.columnName)})`)
    }
  }
  return `CREATE TABLE ${quote(schema)}.${quote(table)} (\n${definitions.join(',\n')}\n);`
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}
