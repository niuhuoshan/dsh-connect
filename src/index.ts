import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { connectDomainSpec } from './domain.js'
import { ApiToolRegistry } from './host/http/tools.js'
import { registerConversationApiTool } from './host/http/conversation-api.js'
import { MetadataProfiler } from './host/metadata/profiler.js'
import { registerMetadataTools } from './host/metadata/tools.js'
import { ConnectRpc } from './host/rpc.js'
import { ConnectStore } from './host/store.js'

export const name = 'dsh-connect'
export const inject = ['storageDomain', 'credentials', 'tools', 'connection']

const CONNECT_SETTINGS_NAMESPACE = settingsNamespace('dsh-connect')
const ConnectSettingsSchema = z.object({
  version: z.number().step(1).min(1).default(1),
})

export async function apply(ctx: Context): Promise<void> {
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.register(CONNECT_SETTINGS_NAMESPACE, ConnectSettingsSchema)
  })
  const domain = await ctx.storageDomain.open(connectDomainSpec)
  const store = new ConnectStore(ctx, domain)
  const apiTools = new ApiToolRegistry(ctx)
  const profiler = new MetadataProfiler(ctx, store)
  const fixedTools: Array<() => void> = []
  let disposeRpc: (() => Promise<void>) | undefined
  try {
    apiTools.replace(store.apiDefinitions())
    fixedTools.push(...registerMetadataTools(ctx, store))
    const rpc = new ConnectRpc(ctx, store, profiler, apiTools)
    fixedTools.push(...registerConversationApiTool(
      ctx,
      input => rpc.validateConversationApi(input),
      input => rpc.createConversationApi(input),
    ))
    disposeRpc = ctx.connection.rpc.handle(
      '/dsh-connect',
      (endpoint, payload, signal) => rpc.handle(endpoint, payload, signal),
      { authority: 'loopback' },
    )
  } catch (error) {
    apiTools.dispose()
    for (const dispose of fixedTools.reverse()) dispose()
    await domain.close()
    throw error
  }

  ctx.effect(() => async () => {
    await profiler.dispose()
    apiTools.dispose()
    for (const dispose of fixedTools.reverse()) dispose()
    await disposeRpc?.()
    await domain.close()
  }, 'dsh-connect runtime')
}

export type * from './types.js'
