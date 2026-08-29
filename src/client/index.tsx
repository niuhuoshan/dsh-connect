import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ConnectSettings } from './ConnectSettings.js'
import { ConnectClient } from './rpc.js'
import { installConnectStyles } from './styles.js'

export const name = 'dsh-connect-client'
export const inject = ['slots', 'connection']

export function apply(ctx: ClientContext): void {
  installConnectStyles(ctx)
  // Host and browser halves share one TypeScript program, so Cordis sees both
  // connection service declarations even though this module only runs in the browser.
  const client = new ConnectClient(ctx.connection.rpc as unknown as ClientConnectionRpc)
  const section = {
    name: 'settings.section',
    id: 'dsh-connect',
    order: 35,
    label: 'DSH连接器',
    icon: 'connection',
    inject: () => ({ connectClient: client }),
  } as const
  ctx.slots.inject('settings.section', () => ctx.slots.register(section, ConnectSettings))
}
