import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'

export class ConnectClient {
  constructor(private readonly rpc: ClientConnectionRpc) {}

  async call<T>(endpoint: string, payload: unknown = {}): Promise<T> {
    const result = await this.rpc.call('/dsh-connect', endpoint, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }
}
