import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  diagnosticsRequest,
  diagnosticCloudResult,
  diagnosticCapabilities
} from './diagnostics-cloud'
const settings = vi.hoisted(() => ({ cloud: { apiKey: 'test-key' } }))
vi.mock('./settings-store', () => ({
  getMachineId: () => 'device-id',
  getSettings: () => settings
}))
beforeEach(() => {
  settings.cloud.apiKey = 'test-key'
})
afterEach(() => vi.unstubAllGlobals())
it('offers Cloud when unlinked without making a network request', async () => {
  settings.cloud.apiKey = ''
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  await expect(diagnosticCapabilities()).resolves.toMatchObject({
    available: false,
    accessReason: 'unlinked'
  })
  expect(fetcher).not.toHaveBeenCalled()
})
it.each([
  [402, 'subscription'],
  [401, 'authorization'],
  [403, 'authorization']
])('returns an actionable access state for HTTP %s', async (status, accessReason) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: Number(status) }))
  )
  await expect(diagnosticCapabilities()).resolves.toMatchObject({ available: false, accessReason })
})
it('does not treat a connection or server failure as an upgrade requirement', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 500 }))
  )
  await expect(diagnosticCapabilities()).rejects.toThrow('unavailable')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
  )
  await expect(diagnosticCapabilities()).rejects.toThrow('fetch failed')
})
it.each([true, false])('preserves server entitlement when available is %s', async (available) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            available,
            requiredPlan: 'Pro',
            provider: 'OpenAI',
            retentionDays: 7,
            accessReason: 'unlinked'
          })
        )
    )
  )
  const result = await diagnosticCapabilities()
  expect(result.available).toBe(available)
  expect(result.accessReason).toBe(available ? undefined : 'subscription')
})
it('refuses an account switch before sending any consented data', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  await expect(
    diagnosticsRequest('POST', '12345678-1234-4123-8123-123456789012', '{}', 'previous-account')
  ).rejects.toThrow('Cloud account changed')
  expect(fetcher).not.toHaveBeenCalled()
})
it('uses only the fixed Cloud destination and rejects redirects', async () => {
  const fetcher = vi.fn(async () => new Response('{"deleted":true}'))
  vi.stubGlobal('fetch', fetcher)
  await expect(
    diagnosticsRequest('DELETE', '12345678-1234-4123-8123-123456789012')
  ).resolves.toEqual({ deleted: true })
  expect(fetcher.mock.calls[0]).toEqual([
    expect.stringMatching(
      /^https:\/\/cloud\.usekudu\.com\/api\/devices\/device-id\/performance-diagnostics\//
    ),
    expect.objectContaining({ redirect: 'error', method: 'DELETE' })
  ])
  await expect(diagnosticsRequest('POST', 'https://attacker.example')).rejects.toThrow('Invalid')
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('bounds response bodies and hides provider/error body contents', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('x'.repeat(262145)))
  )
  await expect(diagnosticsRequest('GET', 'capabilities')).rejects.toThrow('size limit')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('SECRET server details', { status: 500 }))
  )
  await expect(diagnosticsRequest('GET', 'capabilities')).rejects.toThrow(
    'Cloud diagnostics is unavailable'
  )
})
it('maps subscription and timeout failures to actionable messages', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 402 }))
  )
  await expect(diagnosticsRequest('GET', 'capabilities')).rejects.toMatchObject({
    status: 402,
    message: expect.stringContaining('subscription')
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    })
  )
  await expect(diagnosticsRequest('GET', 'capabilities')).rejects.toThrow('timed out')
})
it('rejects reports with mismatched ownership or missing completion payload', () => {
  expect(() => diagnosticCloudResult({ recordId: 'other' }, 'expected', 1000)).toThrow('Invalid')
  expect(() =>
    diagnosticCloudResult(
      {
        recordId: 'expected',
        status: 'complete',
        report: null,
        errorCode: null,
        expiresAt: new Date().toISOString()
      },
      'expected',
      1000
    )
  ).toThrow('Invalid')
})
