import { afterEach, expect, it, vi } from 'vitest'
import { diagnosticsRequest, diagnosticCloudResult } from './diagnostics-cloud'
vi.mock('./settings-store', () => ({
  getMachineId: () => 'device-id',
  getSettings: () => ({ cloud: { apiKey: 'test-key' } })
}))
afterEach(() => vi.unstubAllGlobals())
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
