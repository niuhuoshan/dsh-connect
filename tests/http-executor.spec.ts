import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiDefinition } from '../src/types.js'
import { SecureHttpExecutor, resolveJsonPointer } from '../src/host/http/executor.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HTTP API execution', () => {
  it('resolves RFC 6901 JSON pointers', () => {
    const value = { data: { 'a/b': [{ '~key': 42 }] } }
    expect(resolveJsonPointer(value, '/data/a~1b/0/~0key')).toBe(42)
    expect(() => resolveJsonPointer(value, '/data/missing')).toThrow('not found')
  })

  it('builds only the configured request and extracts a bounded response', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.example.com/v1/users/a%2Fb?limit=2')
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('error')
      expect(new Headers(init?.headers).get('tenant')).toBe('acme')
      expect(init?.body).toBe(JSON.stringify({ filter: { active: true } }))
      return new Response(JSON.stringify({ payload: { items: [1, 2] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const executor = new SecureHttpExecutor({ credentials: {} } as Context)
    const result = await executor.execute(definition(), {
      user: 'a/b', limit: 2, tenant: 'acme', filter: { active: true },
    })
    expect(result.body).toEqual([1, 2])
    expect(result.truncated).toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rejects unknown and incorrectly typed model arguments before fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const executor = new SecureHttpExecutor({ credentials: {} } as Context)
    await expect(executor.execute(definition(), { user: 'x', limit: '2', tenant: 'a', filter: {} }))
      .rejects.toThrow('limit must be integer')
    await expect(executor.execute(definition(), { user: 'x', limit: 2, tenant: 'a', filter: {}, url: 'https://evil.test' }))
      .rejects.toThrow('Unknown API parameter: url')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

function definition(): ApiDefinition {
  return {
    id: '2f0b87ed-7dab-4b5e-a286-a38a6e26e4be',
    name: 'Users',
    slug: 'users',
    description: 'Read users',
    method: 'POST',
    baseUrl: 'https://api.example.com',
    pathTemplate: '/v1/users/{user}',
    parameters: [
      { name: 'user', location: 'path', type: 'string', description: '', required: true },
      { name: 'limit', location: 'query', type: 'integer', description: '', required: true },
      { name: 'tenant', location: 'header', type: 'string', description: '', required: true },
      { name: 'filter', location: 'body', type: 'json', description: '', required: true },
    ],
    auth: { type: 'none' },
    timeoutMs: 10_000,
    maxResponseBytes: 1024,
    responsePointer: '/payload/items',
    allowPrivateNetwork: true,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
}
