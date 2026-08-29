import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ApiDefinition, ApiExecutionResult, ApiParameter } from '../../types.js'
import { assertOutboundTarget, assertSafeHeaderName, parseConfiguredBaseUrl } from './security.js'

const BLOCKED_PARAMETER_HEADERS = new Set(['authorization', 'proxy-authorization'])

export class SecureHttpExecutor {
  constructor(private readonly ctx: Context) {}

  async execute(definition: ApiDefinition, rawArgs: unknown, signal?: AbortSignal): Promise<ApiExecutionResult> {
    const args = validateArguments(definition.parameters, rawArgs)
    const base = parseConfiguredBaseUrl(definition.baseUrl)
    const path = replacePathParameters(definition.pathTemplate, definition.parameters, args)
    const target = new URL(path, base)
    if (target.origin !== base.origin) throw new Error('API path must stay on the configured origin')
    await assertOutboundTarget(target, definition.allowPrivateNetwork)

    const headers = new Headers({ Accept: 'application/json, text/plain;q=0.9, */*;q=0.5' })
    const bodyValues: Record<string, unknown> = {}
    for (const parameter of definition.parameters) {
      const value = args[parameter.name]
      if (value === undefined || parameter.location === 'path') continue
      if (parameter.location === 'query') target.searchParams.append(parameter.name, serializeScalar(value))
      if (parameter.location === 'header') {
        assertSafeHeaderName(parameter.name)
        if (BLOCKED_PARAMETER_HEADERS.has(parameter.name.toLowerCase())) {
          throw new Error(`Header ${parameter.name} cannot be supplied by the model`)
        }
        headers.set(parameter.name, serializeScalar(value))
      }
      if (parameter.location === 'body') bodyValues[parameter.name] = value
    }

    await this.applyAuth(definition, target, headers)
    let body: string | undefined
    if (!['GET', 'DELETE'].includes(definition.method) && Object.keys(bodyValues).length > 0) {
      body = JSON.stringify(bodyValues)
      headers.set('Content-Type', 'application/json')
    }

    const timeout = AbortSignal.timeout(definition.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const started = Date.now()
    const response = await fetch(target, {
      method: definition.method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: 'error',
      signal: combined,
    })
    const payload = await readBounded(response, definition.maxResponseBytes)
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
    const parsed = parseBody(payload.text, contentType)
    const selected = definition.responsePointer === '' ? parsed : resolveJsonPointer(parsed, definition.responsePointer)
    if (!response.ok) {
      const detail = typeof selected === 'string' ? selected : JSON.stringify(selected)
      throw new Error(`HTTP ${response.status}: ${detail.slice(0, 500)}`)
    }
    return {
      status: response.status,
      contentType,
      body: selected,
      truncated: payload.truncated,
      durationMs: Date.now() - started,
    }
  }

  private async applyAuth(definition: ApiDefinition, target: URL, headers: Headers): Promise<void> {
    const auth = definition.auth
    if (auth.type === 'none') return
    const resolved = await this.ctx.credentials.resolve(credentialRef(auth.credentialRef))
    if (resolved === undefined) throw new Error(`Credential ${auth.credentialRef} is not configured`)
    if (auth.type === 'bearer') headers.set('Authorization', `Bearer ${resolved.value}`)
    if (auth.type === 'basic') {
      headers.set('Authorization', `Basic ${Buffer.from(`${auth.username}:${resolved.value}`).toString('base64')}`)
    }
    if (auth.type === 'api-key') {
      if (auth.location === 'header') {
        assertSafeHeaderName(auth.name)
        headers.set(auth.name, resolved.value)
      } else {
        target.searchParams.set(auth.name, resolved.value)
      }
    }
  }
}

function validateArguments(parameters: ApiParameter[], raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Tool arguments must be an object')
  const source = raw as Record<string, unknown>
  const known = new Set(parameters.map(parameter => parameter.name))
  for (const key of Object.keys(source)) {
    if (!known.has(key)) throw new Error(`Unknown API parameter: ${key}`)
  }
  const result: Record<string, unknown> = {}
  for (const parameter of parameters) {
    const value = source[parameter.name]
    if (value === undefined) {
      if (parameter.required) throw new Error(`Missing required API parameter: ${parameter.name}`)
      continue
    }
    if (!matchesType(parameter.type, value)) throw new Error(`API parameter ${parameter.name} must be ${parameter.type}`)
    result[parameter.name] = value
  }
  return result
}

function matchesType(type: ApiParameter['type'], value: unknown): boolean {
  if (type === 'string') return typeof value === 'string'
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value)
  return value === null || typeof value === 'string' || typeof value === 'number'
    || typeof value === 'boolean' || Array.isArray(value) || typeof value === 'object'
}

function replacePathParameters(template: string, parameters: ApiParameter[], args: Record<string, unknown>): string {
  let path = template.startsWith('/') ? template : `/${template}`
  for (const parameter of parameters.filter(item => item.location === 'path')) {
    const value = args[parameter.name]
    if (value === undefined) throw new Error(`Path parameter ${parameter.name} is required`)
    path = path.replaceAll(`{${parameter.name}}`, encodeURIComponent(serializeScalar(value)))
  }
  if (/\{[^}]+\}/.test(path)) throw new Error('API path contains an unresolved placeholder')
  return path
}

function serializeScalar(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value)
}

async function readBounded(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (response.body === null) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const remaining = maxBytes - size
      if (next.value.byteLength > remaining) {
        if (remaining > 0) chunks.push(next.value.slice(0, remaining))
        truncated = true
        await reader.cancel('dsh-connect response limit reached')
        break
      }
      chunks.push(next.value)
      size += next.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(bytes), truncated }
}

function parseBody(text: string, contentType: string): unknown {
  if (text === '') return null
  if (contentType === 'application/json' || contentType.endsWith('+json')) {
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('API returned invalid JSON')
    }
  }
  return text
}

export function resolveJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value
  if (!pointer.startsWith('/')) throw new Error('Response pointer must be empty or start with /')
  let current = value
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(current)) {
      const index = Number(key)
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) throw new Error(`Response pointer not found: ${pointer}`)
      current = current[index]
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, key)) {
      current = (current as Record<string, unknown>)[key]
    } else {
      throw new Error(`Response pointer not found: ${pointer}`)
    }
  }
  return current
}
