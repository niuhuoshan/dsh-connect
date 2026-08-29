import type { DatabaseType } from '../../types.js'
import type { DataSourceProvider } from './provider.js'
import { ClickhouseProvider } from './clickhouse.js'
import { MysqlProvider } from './mysql.js'
import { PostgresqlProvider } from './postgresql.js'

const providers: Record<DatabaseType, DataSourceProvider> = {
  mysql: new MysqlProvider(),
  postgresql: new PostgresqlProvider(),
  clickhouse: new ClickhouseProvider(),
}

export function providerFor(type: DatabaseType): DataSourceProvider {
  return providers[type]
}
