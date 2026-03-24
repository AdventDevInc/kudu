import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────

const handleMap = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handleMap.set(channel, handler)
    }),
  },
}))

vi.mock('../../shared/channels', () => ({
  IPC: {
    CLOUD_LINK: 'cloud:link',
    CLOUD_UNLINK: 'cloud:unlink',
    CLOUD_GET_STATUS: 'cloud:get-status',
    CLOUD_RECONNECT: 'cloud:reconnect',
    THREAT_MONITOR_GET_SNAPSHOT: 'threat-monitor:get-snapshot',
  },
}))

vi.mock('../services/cloud-agent', () => ({
  cloudAgent: {
    link: vi.fn(),
    unlink: vi.fn(),
    getStatus: vi.fn(),
    reconnect: vi.fn(),
  },
}))

vi.mock('../services/threat-monitor', () => ({
  threatMonitor: {
    getThreatSnapshot: vi.fn(),
  },
}))

import { registerCloudAgentIpc } from './cloud-agent.ipc'
import { cloudAgent } from '../services/cloud-agent'
import { threatMonitor } from '../services/threat-monitor'

const mockCloudAgent = cloudAgent as unknown as {
  link: ReturnType<typeof vi.fn>
  unlink: ReturnType<typeof vi.fn>
  getStatus: ReturnType<typeof vi.fn>
  reconnect: ReturnType<typeof vi.fn>
}

const mockThreatMonitor = threatMonitor as unknown as {
  getThreatSnapshot: ReturnType<typeof vi.fn>
}

// ── Helpers ──────────────────────────────────────────────────

function invoke(channel: string, ...args: unknown[]) {
  const handler = handleMap.get(channel)
  if (!handler) throw new Error(`No handler registered for ${channel}`)
  return handler({} /* _event */, ...args)
}

// ── Tests ────────────────────────────────────────────────────

describe('cloud-agent IPC', () => {
  beforeEach(() => {
    handleMap.clear()
    vi.clearAllMocks()
  })

  it('registers all five IPC handlers', () => {
    registerCloudAgentIpc()
    expect(handleMap.has('cloud:link')).toBe(true)
    expect(handleMap.has('cloud:unlink')).toBe(true)
    expect(handleMap.has('cloud:get-status')).toBe(true)
    expect(handleMap.has('cloud:reconnect')).toBe(true)
    expect(handleMap.has('threat-monitor:get-snapshot')).toBe(true)
  })

  // ── CLOUD_LINK ─────────────────────────────────────────────

  describe('CLOUD_LINK', () => {
    it('delegates to cloudAgent.link with a valid API key', async () => {
      const expected = { success: true }
      mockCloudAgent.link.mockResolvedValue(expected)

      registerCloudAgentIpc()
      const result = await invoke('cloud:link', 'valid-api-key-1234')

      expect(result).toEqual(expected)
      expect(mockCloudAgent.link).toHaveBeenCalledWith('valid-api-key-1234')
    })

    it('accepts API key at minimum length (10 chars)', async () => {
      mockCloudAgent.link.mockResolvedValue({ success: true })

      registerCloudAgentIpc()
      const result = await invoke('cloud:link', '1234567890')

      expect(result).toEqual({ success: true })
      expect(mockCloudAgent.link).toHaveBeenCalledWith('1234567890')
    })

    it('accepts API key at maximum length (200 chars)', async () => {
      mockCloudAgent.link.mockResolvedValue({ success: true })
      const key = 'a'.repeat(200)

      registerCloudAgentIpc()
      const result = await invoke('cloud:link', key)

      expect(result).toEqual({ success: true })
      expect(mockCloudAgent.link).toHaveBeenCalledWith(key)
    })

    it('rejects API key shorter than 10 characters', async () => {
      registerCloudAgentIpc()
      const result = await invoke('cloud:link', 'short')

      expect(result).toEqual({ success: false, error: 'Invalid API key' })
      expect(mockCloudAgent.link).not.toHaveBeenCalled()
    })

    it('rejects API key longer than 200 characters', async () => {
      registerCloudAgentIpc()
      const result = await invoke('cloud:link', 'a'.repeat(201))

      expect(result).toEqual({ success: false, error: 'Invalid API key' })
      expect(mockCloudAgent.link).not.toHaveBeenCalled()
    })

    it('rejects non-string API key (number)', async () => {
      registerCloudAgentIpc()
      const result = await invoke('cloud:link', 12345678901)

      expect(result).toEqual({ success: false, error: 'Invalid API key' })
      expect(mockCloudAgent.link).not.toHaveBeenCalled()
    })

    it('rejects null API key', async () => {
      registerCloudAgentIpc()
      const result = await invoke('cloud:link', null)

      expect(result).toEqual({ success: false, error: 'Invalid API key' })
      expect(mockCloudAgent.link).not.toHaveBeenCalled()
    })

    it('rejects undefined API key', async () => {
      registerCloudAgentIpc()
      const result = await invoke('cloud:link', undefined)

      expect(result).toEqual({ success: false, error: 'Invalid API key' })
      expect(mockCloudAgent.link).not.toHaveBeenCalled()
    })

    it('rejects empty string API key', async () => {
      registerCloudAgentIpc()
      const result = await invoke('cloud:link', '')

      expect(result).toEqual({ success: false, error: 'Invalid API key' })
      expect(mockCloudAgent.link).not.toHaveBeenCalled()
    })

    it('rejects object API key', async () => {
      registerCloudAgentIpc()
      const result = await invoke('cloud:link', { key: 'value' })

      expect(result).toEqual({ success: false, error: 'Invalid API key' })
      expect(mockCloudAgent.link).not.toHaveBeenCalled()
    })

    it('propagates errors from cloudAgent.link', async () => {
      mockCloudAgent.link.mockRejectedValue(new Error('connection refused'))

      registerCloudAgentIpc()
      await expect(invoke('cloud:link', 'valid-api-key-1234')).rejects.toThrow('connection refused')
    })
  })

  // ── CLOUD_UNLINK ───────────────────────────────────────────

  describe('CLOUD_UNLINK', () => {
    it('delegates to cloudAgent.unlink', async () => {
      const expected = { success: true }
      mockCloudAgent.unlink.mockResolvedValue(expected)

      registerCloudAgentIpc()
      const result = await invoke('cloud:unlink')

      expect(result).toEqual(expected)
      expect(mockCloudAgent.unlink).toHaveBeenCalledOnce()
    })

    it('propagates errors from cloudAgent.unlink', async () => {
      mockCloudAgent.unlink.mockRejectedValue(new Error('unlink failed'))

      registerCloudAgentIpc()
      await expect(invoke('cloud:unlink')).rejects.toThrow('unlink failed')
    })
  })

  // ── CLOUD_GET_STATUS ───────────────────────────────────────

  describe('CLOUD_GET_STATUS', () => {
    it('delegates to cloudAgent.getStatus', () => {
      const expected = { linked: true, connected: true }
      mockCloudAgent.getStatus.mockReturnValue(expected)

      registerCloudAgentIpc()
      const result = invoke('cloud:get-status')

      expect(result).toEqual(expected)
      expect(mockCloudAgent.getStatus).toHaveBeenCalledOnce()
    })

    it('returns status synchronously (not async)', () => {
      mockCloudAgent.getStatus.mockReturnValue({ linked: false, connected: false })

      registerCloudAgentIpc()
      const result = invoke('cloud:get-status')

      // Should not be a promise
      expect(result).toEqual({ linked: false, connected: false })
    })
  })

  // ── CLOUD_RECONNECT ────────────────────────────────────────

  describe('CLOUD_RECONNECT', () => {
    it('delegates to cloudAgent.reconnect', async () => {
      const expected = { success: true }
      mockCloudAgent.reconnect.mockResolvedValue(expected)

      registerCloudAgentIpc()
      const result = await invoke('cloud:reconnect')

      expect(result).toEqual(expected)
      expect(mockCloudAgent.reconnect).toHaveBeenCalledOnce()
    })

    it('propagates errors from cloudAgent.reconnect', async () => {
      mockCloudAgent.reconnect.mockRejectedValue(new Error('reconnect failed'))

      registerCloudAgentIpc()
      await expect(invoke('cloud:reconnect')).rejects.toThrow('reconnect failed')
    })
  })

  // ── THREAT_MONITOR_GET_SNAPSHOT ────────────────────────────

  describe('THREAT_MONITOR_GET_SNAPSHOT', () => {
    it('delegates to threatMonitor.getThreatSnapshot', () => {
      const snapshot = {
        flaggedConnections: [],
        flaggedDns: [],
        blacklistVersion: '2025-01-01',
        lastConnectionScanAt: '2025-01-01T12:00:00Z',
        lastDnsScanAt: '2025-01-01T12:00:00Z',
      }
      mockThreatMonitor.getThreatSnapshot.mockReturnValue(snapshot)

      registerCloudAgentIpc()
      const result = invoke('threat-monitor:get-snapshot')

      expect(result).toEqual(snapshot)
      expect(mockThreatMonitor.getThreatSnapshot).toHaveBeenCalledOnce()
    })

    it('returns null values in snapshot', () => {
      const snapshot = {
        flaggedConnections: [],
        flaggedDns: [],
        blacklistVersion: null,
        lastConnectionScanAt: null,
        lastDnsScanAt: null,
      }
      mockThreatMonitor.getThreatSnapshot.mockReturnValue(snapshot)

      registerCloudAgentIpc()
      const result = invoke('threat-monitor:get-snapshot')

      expect(result).toEqual(snapshot)
    })
  })
})
