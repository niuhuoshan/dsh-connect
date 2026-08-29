import { describe, expect, it } from 'vitest'
import { assertSafeHeaderName, isPrivateAddress, parseConfiguredBaseUrl } from '../src/host/http/security.js'

describe('configured HTTP API security', () => {
  it('accepts only credential-free HTTP(S) base URLs', () => {
    expect(parseConfiguredBaseUrl('https://api.example.com/v1').origin).toBe('https://api.example.com')
    expect(() => parseConfiguredBaseUrl('ftp://api.example.com')).toThrow('Only HTTP and HTTPS')
    expect(() => parseConfiguredBaseUrl('https://user:secret@example.com')).toThrow('Credentials must not be embedded')
    expect(() => parseConfiguredBaseUrl('https://example.com/#token')).toThrow('must not contain a fragment')
  })

  it('blocks headers controlled by the executor', () => {
    expect(() => assertSafeHeaderName('X-Tenant')).not.toThrow()
    for (const name of ['Authorization', 'Host', 'Cookie', 'Content-Length']) {
      expect(() => assertSafeHeaderName(name)).toThrow('controlled by dsh-connect')
    }
    expect(() => assertSafeHeaderName('bad header')).toThrow('Invalid HTTP header')
  })

  it('classifies local, private, link-local, documentation, and reserved addresses', () => {
    for (const address of [
      '0.0.0.0', '10.2.3.4', '100.64.0.1', '127.0.0.1', '169.254.1.2',
      '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.1',
      '203.0.113.1', '224.0.0.1', '::', '::1', '[::1]', 'fd00::1', 'fe80::1',
      'ff02::1', '2001:db8::1', '2002::1', '::ffff:127.0.0.1', 'not-an-ip',
    ]) expect(isPrivateAddress(address), address).toBe(true)
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false)
  })
})
