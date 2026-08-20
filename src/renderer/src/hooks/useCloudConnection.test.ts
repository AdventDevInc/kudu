import { describe, expect, it } from 'vitest'
import { cloudConnectionStateFromStatus } from './useCloudConnection'

describe('cloudConnectionStateFromStatus', () => {
  it('reports an active connection', () => {
    expect(cloudConnectionStateFromStatus({ status: 'connected', error: null })).toBe('connected')
  })

  it('separates subscription failures from ordinary disconnections', () => {
    expect(cloudConnectionStateFromStatus({
      status: 'error',
      error: 'Kudu Cloud subscription required — add an active subscription to connect this device.',
    })).toBe('subscription-required')
    expect(cloudConnectionStateFromStatus({ status: 'disconnected', error: 'Network unavailable' })).toBe('disconnected')
  })

  it('recognizes invalid or unauthorized API keys', () => {
    expect(cloudConnectionStateFromStatus({
      status: 'error',
      error: 'Access denied — your API key is invalid or no longer authorized.',
    })).toBe('authorization-error')
  })
})
