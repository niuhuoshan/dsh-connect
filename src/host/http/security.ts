import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'cookie',
])

export function assertSafeHeaderName(name: string): void {
  const normalized = name.trim().toLowerCase()
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(normalized)) {
    throw new Error(`Invalid HTTP header name: ${name}`)
  }
  if (FORBIDDEN_HEADERS.has(normalized)) {
    throw new Error(`HTTP header ${name} is controlled by dsh-connect`)
  }
}

export function parseConfiguredBaseUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS API targets are supported')
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('Credentials must not be embedded in the API URL')
  }
  if (url.hash !== '') throw new Error('API base URL must not contain a fragment')
  return url
}

export async function assertOutboundTarget(url: URL, allowPrivateNetwork: boolean): Promise<void> {
  if (allowPrivateNetwork) return
  const addresses = isIP(url.hostname) === 0
    ? await lookup(url.hostname, { all: true, verbatim: true })
    : [{ address: url.hostname, family: isIP(url.hostname) }]
  if (addresses.length === 0) throw new Error('API target did not resolve to an address')
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error('API target resolves to a private, loopback, link-local, or reserved address')
    }
  }
}

export function isPrivateAddress(raw: string): boolean {
  const lower = raw.toLowerCase()
  const unbracketed = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower
  const address = unbracketed.split('%', 1)[0] ?? unbracketed
  if (address.includes(':')) {
    if (isIP(address) !== 6) return true
    if (address === '::' || address === '::1') return true
    if (address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe8')
      || address.startsWith('fe9') || address.startsWith('fea') || address.startsWith('feb')) return true
    if (address.startsWith('::ffff:')) return isPrivateAddress(address.slice('::ffff:'.length))
    return address.startsWith('ff')
      || address.startsWith('2001:db8:')
      || address.startsWith('2001:0db8:')
      || address.startsWith('2001:10:')
      || address.startsWith('2001:20:')
      || address.startsWith('2002:')
  }
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true
  const [a, b, c] = parts as [number, number, number, number]
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224
}
