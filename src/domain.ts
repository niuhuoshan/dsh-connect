import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  apiDefinitionSchema,
  dataSourceSchema,
  metadataChangeSchema,
  metricDefinitionSchema,
  metadataProfileSchema,
  profileJobSchema,
} from './types.js'

export const connectDomainSpec = defineDomain({
  name: 'dsh_connect',
  version: 0,
  tables: {
    data_sources: domainTable(dataSourceSchema),
    api_definitions: domainTable(apiDefinitionSchema),
    metadata_profiles: domainTable(metadataProfileSchema),
    profile_jobs: domainTable(profileJobSchema),
    metrics: domainTable(metricDefinitionSchema),
    metadata_changes: domainTable(metadataChangeSchema),
  },
})

export type ConnectDomain = Domain<typeof connectDomainSpec>
