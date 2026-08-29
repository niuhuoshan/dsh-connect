import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { DataSourceDefinition, MetadataProfile, ProfileJob } from '../../types.js'
import { providerFor } from '../datasource/index.js'
import type { DiscoveredObject } from '../datasource/provider.js'
import { ConnectStore } from '../store.js'
import { METADATA_MODEL_PROMPT_VERSION, MetadataEnricher, type MetadataModelRoute } from './enricher.js'

interface RunningJob {
  controller: AbortController
  done: Promise<void>
}

export class MetadataProfiler {
  private readonly running = new Map<string, RunningJob>()
  private readonly enricher: MetadataEnricher

  constructor(
    private readonly ctx: Context,
    private readonly store: ConnectStore,
  ) {
    this.enricher = new MetadataEnricher(ctx)
  }

  async test(source: DataSourceDefinition, signal?: AbortSignal): Promise<void> {
    const password = await this.resolvePassword(source)
    await providerFor(source.type).test(source, password, signal)
  }

  async start(sourceId: string, mode: ProfileJob['mode'] = 'incremental'): Promise<ProfileJob> {
    const source = this.store.dataSource(sourceId)
    if (source === undefined) throw new Error('Data source not found')
    if (!source.enabled) throw new Error('Data source is disabled')
    if (mode === 'rebuild-ai' && !source.aiEnrichment) throw new Error('请先在数据库设置中开启 AI 语义增强')
    if (this.running.has(sourceId)) throw new Error('A metadata scan is already running for this data source')
    await this.resolvePassword(source)

    const now = Date.now()
    const job: ProfileJob = {
      id: randomUUID(),
      sourceId,
      status: 'queued',
      mode,
      total: 0,
      processed: 0,
      startedAt: now,
      updatedAt: now,
    }
    await this.store.putJob(job)
    const controller = new AbortController()
    const done = this.run(source, job, controller.signal).finally(() => {
      this.running.delete(sourceId)
    })
    this.running.set(sourceId, { controller, done })
    void done.catch(() => {})
    return job
  }

  async cancel(sourceId: string): Promise<{ stopped: true; processed: number; total: number }> {
    const active = this.running.get(sourceId)
    active?.controller.abort('metadata scan cancelled')

    // Do not wait for a database driver or model stream to release its
    // connection. Remove the unfinished job immediately so stopping a scan
    // does not become the data source's permanent status. Profiles already
    // committed table by table remain available.
    const current = this.store.jobs(sourceId).find(job => job.status === 'queued' || job.status === 'running')
    if (current !== undefined) await this.store.deleteJob(current.id)
    return { stopped: true, processed: current?.processed ?? 0, total: current?.total ?? 0 }
  }

  async dispose(): Promise<void> {
    const active = [...this.running.values()]
    for (const job of active) job.controller.abort('dsh-connect is unloading')
    await Promise.allSettled(active.map(job => job.done))
  }

  private async run(source: DataSourceDefinition, initial: ProfileJob, signal: AbortSignal): Promise<void> {
    const route = source.aiEnrichment ? this.modelRoute() : undefined
    let job = { ...initial, status: 'running' as const, updatedAt: Date.now() }
    if (route !== undefined) job = { ...job, modelProvider: route.provider, modelName: route.model }
    await this.store.putJob(job)
    try {
      const password = await this.resolvePassword(source)
      const objects = await providerFor(source.type).discover(source, password, signal)
      signal.throwIfAborted()
      job = { ...job, total: objects.length, updatedAt: Date.now() }
      await this.store.putJob(job)
      const keep = new Set<string>()
      for (const object of objects) {
        signal.throwIfAborted()
        const id = profileId(source.id, object)
        keep.add(id)
        job = { ...job, currentObject: `${object.schemaName}.${object.objectName}`, updatedAt: Date.now() }
        await this.store.putJob(job)
        const fingerprint = fingerprintOf(object)
        const semanticFingerprint = semanticFingerprintOf(fingerprint, source.aiEnrichment, route)
        const existing = this.store.profile(id)
        const rebuild = initial.mode === 'full'
          || (initial.mode === 'rebuild-ai' && source.aiEnrichment)
        if (rebuild || existing === undefined || existing.semanticFingerprint !== semanticFingerprint) {
          const semantic = await this.enricher.enrich(object, source.aiEnrichment, signal, route)
          signal.throwIfAborted()
          const profile: MetadataProfile = {
            id,
            sourceId: source.id,
            schemaName: object.schemaName,
            objectName: object.objectName,
            objectType: object.objectType,
            ...(object.engine === undefined ? {} : { engine: object.engine }),
            ...(object.comment === undefined ? {} : { comment: object.comment }),
            ddl: object.ddl.slice(0, 100_000),
            columns: object.columns,
            sample: object.sample,
            term: semantic.term,
            description: semantic.description,
            tags: semantic.tags,
            synonyms: semantic.synonyms,
            semanticColumns: semantic.semanticColumns,
            confidence: semantic.confidence,
            confidenceReason: semantic.confidenceReason,
            temporary: semantic.temporary,
            ignored: existing?.ignoredOverride ?? (semantic.temporary || semantic.confidence < 60),
            ...(existing?.ignoredOverride === undefined ? {} : { ignoredOverride: existing.ignoredOverride }),
            fingerprint,
            semanticFingerprint,
            ...(semantic.modelProvider === undefined ? {} : { modelProvider: semantic.modelProvider }),
            ...(semantic.modelName === undefined ? {} : { modelName: semantic.modelName }),
            ...(semantic.modelReasoningEffort === undefined ? {} : { modelReasoningEffort: semantic.modelReasoningEffort }),
            ...(semantic.modelAnalyzedAt === undefined ? {} : { modelAnalyzedAt: semantic.modelAnalyzedAt }),
            modelStatus: semantic.modelStatus,
            modelPromptVersion: METADATA_MODEL_PROMPT_VERSION,
            profiledAt: Date.now(),
          }
          await this.store.putProfile(profile)
          await this.store.putChange({
            id: randomUUID(),
            sourceId: source.id,
            profileId: profile.id,
            action: initial.mode === 'rebuild-ai' ? 'model' : 'scan',
            summary: initial.mode === 'rebuild-ai' ? 'AI 语义建模完成' : '物理元数据扫描完成',
            after: { term: profile.term, description: profile.description, modelStatus: profile.modelStatus, confidence: profile.confidence },
            changedAt: Date.now(),
          })
        }
        signal.throwIfAborted()
        job = { ...job, processed: job.processed + 1, updatedAt: Date.now() }
        await this.store.putJob(job)
      }
      signal.throwIfAborted()
      await this.store.deleteStaleProfiles(source.id, keep)
      const { currentObject: _currentObject, ...completedJob } = job
      await this.store.putJob({
        ...completedJob,
        status: 'completed',
        processed: objects.length,
        updatedAt: Date.now(),
        finishedAt: Date.now(),
      })
    } catch (error) {
      const cancelled = signal.aborted
      if (cancelled) {
        await this.store.deleteJob(job.id)
      } else {
        const { currentObject: _currentObject, ...failedJob } = job
        await this.store.putJob({
          ...failedJob,
          status: 'failed',
          error: safeError(error),
          updatedAt: Date.now(),
          finishedAt: Date.now(),
        })
      }
    }
  }

  private async resolvePassword(source: DataSourceDefinition): Promise<string> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(source.credentialRef))
    if (resolved === undefined) throw new Error('Database credential is not configured')
    return resolved.value
  }

  private modelRoute(): MetadataModelRoute | undefined {
    const defaults = this.ctx.get('agentDefaultModel') as { currentSelection(): MetadataModelRoute } | undefined
    if (defaults === undefined) return undefined
    try {
      return defaults.currentSelection()
    } catch {
      return undefined
    }
  }
}

function profileId(sourceId: string, object: Pick<DiscoveredObject, 'schemaName' | 'objectName'>): string {
  return `${sourceId}:${object.schemaName}:${object.objectName}`
}

function fingerprintOf(object: DiscoveredObject): string {
  return createHash('sha256').update(JSON.stringify({
    schemaName: object.schemaName,
    objectName: object.objectName,
    objectType: object.objectType,
    engine: object.engine,
    comment: object.comment,
    ddl: object.ddl,
    columns: object.columns,
    sample: object.sample,
  })).digest('hex')
}

function semanticFingerprintOf(physicalFingerprint: string, aiEnabled: boolean, route: MetadataModelRoute | undefined): string {
  return createHash('sha256').update(JSON.stringify({
    physicalFingerprint,
    aiEnabled,
    promptVersion: METADATA_MODEL_PROMPT_VERSION,
    provider: aiEnabled ? route?.provider : undefined,
    model: aiEnabled ? route?.model : undefined,
    reasoningEffort: aiEnabled ? route?.reasoningEffort : undefined,
  })).digest('hex')
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/[\r\n]+/g, ' ').slice(0, 1000)
}
