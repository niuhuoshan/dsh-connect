import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { ConnectDomain } from '../domain.js'
import type {
  ApiDefinition,
  ApiDefinitionView,
  DataSourceDefinition,
  DataSourceView,
  MetadataChange,
  MetadataProfile,
  MetricDefinition,
  ProfileJob,
} from '../types.js'

export class ConnectStore {
  constructor(
    private readonly ctx: Context,
    readonly domain: ConnectDomain,
  ) {}

  dataSources(): DataSourceDefinition[] {
    return [...this.domain.table('data_sources').entries()]
      .map(([, value]) => value)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  dataSource(id: string): DataSourceDefinition | undefined {
    return this.domain.table('data_sources').get(id)
  }

  async dataSourceViews(): Promise<DataSourceView[]> {
    const jobs = this.jobs()
    const profiles = this.profiles()
    return Promise.all(this.dataSources().map(async source => {
      const { credentialRef, ...safe } = source
      const latestJob = jobs
        .filter(job => job.sourceId === source.id && job.status !== 'cancelled')
        .sort((a, b) => b.startedAt - a.startedAt)[0]
      // `cancelled` is kept in the persisted schema only for compatibility
      // with existing installations. It is not a user-facing source state.
      return {
        ...safe,
        credentialConfigured: (await this.ctx.credentials.describe(credentialRef as CredentialRef)).configured,
        ...(latestJob === undefined ? {} : { latestJob }),
        profileCount: profiles.filter(profile => profile.sourceId === source.id).length,
        aiProfileCount: profiles.filter(profile => profile.sourceId === source.id && profile.modelStatus === 'ai').length,
      }
    }))
  }

  putDataSource(value: DataSourceDefinition): Promise<void> {
    return this.domain.table('data_sources').put(value.id, value)
  }

  async deleteDataSource(id: string): Promise<void> {
    await this.domain.table('data_sources').delete(id)
    const profileTable = this.domain.table('metadata_profiles')
    for (const [key, profile] of profileTable.entries()) {
      if (profile.sourceId === id) await profileTable.delete(key)
    }
    const jobTable = this.domain.table('profile_jobs')
    for (const [key, job] of jobTable.entries()) {
      if (job.sourceId === id) await jobTable.delete(key)
    }
    for (const tableName of ['metrics', 'metadata_changes'] as const) {
      const table = this.domain.table(tableName)
      for (const [key, value] of table.entries()) if (value.sourceId === id) await table.delete(key)
    }
  }

  apiDefinitions(): ApiDefinition[] {
    return [...this.domain.table('api_definitions').entries()]
      .map(([, value]) => value)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  apiDefinition(id: string): ApiDefinition | undefined {
    return this.domain.table('api_definitions').get(id)
  }

  async apiDefinitionViews(): Promise<ApiDefinitionView[]> {
    return Promise.all(this.apiDefinitions().map(async definition => {
      const { auth, ...safe } = definition
      if (auth.type === 'none') {
        return { ...safe, auth: { type: 'none', credentialConfigured: true }, toolName: toolName(definition) }
      }
      const { credentialRef, ...safeAuth } = auth
      return {
        ...safe,
        auth: {
          ...safeAuth,
          credentialConfigured: (await this.ctx.credentials.describe(credentialRef as CredentialRef)).configured,
        },
        toolName: toolName(definition),
      }
    }))
  }

  putApiDefinition(value: ApiDefinition): Promise<void> {
    return this.domain.table('api_definitions').put(value.id, value)
  }

  deleteApiDefinition(id: string): Promise<boolean> {
    return this.domain.table('api_definitions').delete(id)
  }

  profiles(sourceId?: string): MetadataProfile[] {
    return [...this.domain.table('metadata_profiles').entries()]
      .map(([, value]) => value)
      .filter(profile => sourceId === undefined || profile.sourceId === sourceId)
      .sort((a, b) => `${a.schemaName}.${a.objectName}`.localeCompare(`${b.schemaName}.${b.objectName}`))
  }

  profile(id: string): MetadataProfile | undefined {
    return this.domain.table('metadata_profiles').get(id)
  }

  putProfile(value: MetadataProfile): Promise<void> {
    return this.domain.table('metadata_profiles').put(value.id, value)
  }

  metrics(sourceId?: string): MetricDefinition[] {
    return [...this.domain.table('metrics').entries()]
      .map(([, value]) => value)
      .filter(metric => sourceId === undefined || metric.sourceId === sourceId)
      .sort((a, b) => a.term.localeCompare(b.term))
  }

  metric(id: string): MetricDefinition | undefined { return this.domain.table('metrics').get(id) }
  putMetric(value: MetricDefinition): Promise<void> { return this.domain.table('metrics').put(value.id, value) }
  deleteMetric(id: string): Promise<boolean> { return this.domain.table('metrics').delete(id) }

  changes(sourceId?: string, profileId?: string): MetadataChange[] {
    return [...this.domain.table('metadata_changes').entries()]
      .map(([, value]) => value)
      .filter(change => (sourceId === undefined || change.sourceId === sourceId) && (profileId === undefined || change.profileId === profileId))
      .sort((a, b) => b.changedAt - a.changedAt)
  }

  changePage(sourceId: string, profileId: string | undefined, offset: number, limit: number) {
    const changes = this.changes(sourceId, profileId)
    return {
      items: changes.slice(offset, offset + limit).map(({ id, sourceId: itemSourceId, profileId: itemProfileId, action, summary, changedAt }) => ({
        id, sourceId: itemSourceId, profileId: itemProfileId, action, summary, changedAt,
      })),
      offset,
      limit,
      total: changes.length,
      hasMore: offset + limit < changes.length,
    }
  }
  putChange(value: MetadataChange): Promise<void> { return this.domain.table('metadata_changes').put(value.id, value) }

  async deleteStaleProfiles(sourceId: string, keep: ReadonlySet<string>): Promise<void> {
    const table = this.domain.table('metadata_profiles')
    for (const [key, value] of table.entries()) {
      if (value.sourceId === sourceId && !keep.has(key)) await table.delete(key)
    }
  }

  jobs(sourceId?: string): ProfileJob[] {
    return [...this.domain.table('profile_jobs').entries()]
      .map(([, value]) => value)
      .filter(job => job.status !== 'cancelled' && (sourceId === undefined || job.sourceId === sourceId))
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  putJob(value: ProfileJob): Promise<void> {
    return this.domain.table('profile_jobs').put(value.id, value)
  }

  deleteJob(id: string): Promise<boolean> {
    return this.domain.table('profile_jobs').delete(id)
  }
}

export function toolName(definition: Pick<ApiDefinition, 'slug'>): string {
  return `dsh_connect_api_${definition.slug}`
}
