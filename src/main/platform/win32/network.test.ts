import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.fn()

vi.mock('child_process', () => ({
  execFile: execFileMock,
}))

vi.mock('util', () => ({
  promisify: () => execFileMock,
}))

const { createWin32Network } = await import('./network')

describe('win32 network', () => {
  const network = createWin32Network()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getEstablishedConnections', () => {
    it('parses IPv4 established connections from netstat output', async () => {
      execFileMock.mockResolvedValue({
        stdout: [
          'Active Connections',
          '',
          '  Proto  Local Address          Foreign Address        State           PID',
          '  TCP    10.0.0.5:45678         93.184.216.34:443      ESTABLISHED     1234',
          '  TCP    10.0.0.5:50000         151.101.1.140:80       ESTABLISHED     5678',
        ].join('\n'),
        stderr: '',
      })

      const result = await network.getEstablishedConnections()

      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({
        remoteAddress: '93.184.216.34',
        remotePort: 443,
        localPort: 45678,
        pid: 1234,
      })
    })

    it('skips loopback addresses', async () => {
      execFileMock.mockResolvedValue({
        stdout: [
          '  TCP    127.0.0.1:8080         127.0.0.1:49000        ESTABLISHED     100',
          '  TCP    10.0.0.5:45678         93.184.216.34:443      ESTABLISHED     200',
        ].join('\n'),
        stderr: '',
      })

      const result = await network.getEstablishedConnections()
      expect(result).toHaveLength(1)
      expect(result[0].remoteAddress).toBe('93.184.216.34')
    })

    it('skips non-ESTABLISHED lines', async () => {
      execFileMock.mockResolvedValue({
        stdout: [
          '  TCP    10.0.0.5:45678         93.184.216.34:443      LISTENING       1234',
          '  TCP    10.0.0.5:45679         93.184.216.34:443      ESTABLISHED     1234',
          '  TCP    10.0.0.5:45680         93.184.216.34:443      TIME_WAIT       1234',
        ].join('\n'),
        stderr: '',
      })

      const result = await network.getEstablishedConnections()
      expect(result).toHaveLength(1)
      expect(result[0].localPort).toBe(45679)
    })

    it('handles IPv6 bracket notation', async () => {
      execFileMock.mockResolvedValue({
        stdout: '  TCP    [::1]:45678           [2001:db8::1]:443      ESTABLISHED     1234\n',
        stderr: '',
      })

      const result = await network.getEstablishedConnections()
      expect(result).toHaveLength(1)
      expect(result[0].remoteAddress).toBe('2001:db8::1')
      expect(result[0].remotePort).toBe(443)
    })

    it('skips IPv6 loopback addresses', async () => {
      execFileMock.mockResolvedValue({
        stdout: '  TCP    [::1]:45678           [::1]:443              ESTABLISHED     1234\n',
        stderr: '',
      })

      const result = await network.getEstablishedConnections()
      expect(result).toHaveLength(0)
    })

    it('sets pid to null when PID is not numeric', async () => {
      execFileMock.mockResolvedValue({
        stdout: '  TCP    10.0.0.5:45678         93.184.216.34:443      ESTABLISHED     abc\n',
        stderr: '',
      })

      const result = await network.getEstablishedConnections()
      expect(result).toHaveLength(1)
      expect(result[0].pid).toBeNull()
    })

    it('returns empty array on error', async () => {
      execFileMock.mockRejectedValue(new Error('command not found'))
      const result = await network.getEstablishedConnections()
      expect(result).toEqual([])
    })

    it('skips lines with insufficient columns', async () => {
      execFileMock.mockResolvedValue({
        stdout: '  TCP    10.0.0.5:45678\n',
        stderr: '',
      })

      const result = await network.getEstablishedConnections()
      expect(result).toEqual([])
    })
  })

  describe('getListeningPorts', () => {
    it('parses listening ports from netstat output', async () => {
      execFileMock.mockResolvedValue({
        stdout: [
          '  TCP    0.0.0.0:80             0.0.0.0:0              LISTENING       1000',
          '  TCP    0.0.0.0:443            0.0.0.0:0              LISTENING       1001',
          '  TCP    10.0.0.5:45678         93.184.216.34:443      ESTABLISHED     1234',
        ].join('\n'),
        stderr: '',
      })

      const result = await network.getListeningPorts()
      expect(result).toEqual([80, 443])
    })

    it('handles IPv6 bracket notation for listening ports', async () => {
      execFileMock.mockResolvedValue({
        stdout: '  TCP    [::]:8080              [::]:0                 LISTENING       2000\n',
        stderr: '',
      })

      const result = await network.getListeningPorts()
      expect(result).toEqual([8080])
    })

    it('returns empty array on error', async () => {
      execFileMock.mockRejectedValue(new Error('timeout'))
      const result = await network.getListeningPorts()
      expect(result).toEqual([])
    })

    it('skips non-LISTENING lines', async () => {
      execFileMock.mockResolvedValue({
        stdout: '  TCP    10.0.0.5:45678         93.184.216.34:443      ESTABLISHED     1234\n',
        stderr: '',
      })

      const result = await network.getListeningPorts()
      expect(result).toEqual([])
    })
  })

  describe('getDnsCacheEntries', () => {
    it('parses DNS cache entries', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify([
          { Entry: 'example.com', Data: '93.184.216.34' },
          { Entry: 'Google.com', Data: '142.250.80.14' },
        ]),
        stderr: '',
      })

      const result = await network.getDnsCacheEntries()
      expect(result).toEqual([
        { domain: 'example.com', resolvedAddress: '93.184.216.34' },
        { domain: 'google.com', resolvedAddress: '142.250.80.14' },
      ])
    })

    it('handles null Data fields', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ Entry: 'example.com', Data: null }),
        stderr: '',
      })

      const result = await network.getDnsCacheEntries()
      expect(result).toEqual([{ domain: 'example.com', resolvedAddress: null }])
    })

    it('returns empty array for empty output', async () => {
      execFileMock.mockResolvedValue({ stdout: '  ', stderr: '' })
      const result = await network.getDnsCacheEntries()
      expect(result).toEqual([])
    })

    it('returns empty array on error', async () => {
      execFileMock.mockRejectedValue(new Error('access denied'))
      const result = await network.getDnsCacheEntries()
      expect(result).toEqual([])
    })
  })

  describe('flushDnsCache', () => {
    it('returns true on success', async () => {
      execFileMock.mockResolvedValue({ stdout: '', stderr: '' })
      const result = await network.flushDnsCache()
      expect(result).toBe(true)
      expect(execFileMock).toHaveBeenCalledWith('ipconfig', ['/flushdns'], { timeout: 10000, windowsHide: true })
    })

    it('returns false on error', async () => {
      execFileMock.mockRejectedValue(new Error('failed'))
      const result = await network.flushDnsCache()
      expect(result).toBe(false)
    })
  })

  describe('getWifiProfiles', () => {
    it('parses wifi profiles and fetches security details', async () => {
      execFileMock
        .mockResolvedValueOnce({
          stdout: '    All User Profile     : HomeNetwork\n    All User Profile     : WorkWifi\n',
          stderr: '',
        })
        .mockResolvedValueOnce({
          stdout: '    Authentication         : WPA2-Personal\n',
          stderr: '',
        })
        .mockResolvedValueOnce({
          stdout: '    Authentication         : WPA3-Enterprise\n',
          stderr: '',
        })

      const result = await network.getWifiProfiles()
      expect(result).toEqual([
        { name: 'HomeNetwork', security: 'WPA2-Personal' },
        { name: 'WorkWifi', security: 'WPA3-Enterprise' },
      ])
    })

    it('skips profiles with suspicious characters in name', async () => {
      execFileMock.mockResolvedValue({
        stdout: '    All User Profile     : Safe\n    All User Profile     : Mal"icious\n',
        stderr: '',
      })
      // Safe profile detail
      execFileMock.mockResolvedValueOnce({ stdout: '', stderr: '' })

      // Re-mock to handle the sequence properly
      execFileMock.mockReset()
      execFileMock
        .mockResolvedValueOnce({
          stdout: '    All User Profile     : Safe\n    All User Profile     : Mal"icious\n',
          stderr: '',
        })
        .mockResolvedValueOnce({
          stdout: '    Authentication         : WPA2-Personal\n',
          stderr: '',
        })

      const result = await network.getWifiProfiles()
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Safe')
    })

    it('returns empty array on error', async () => {
      execFileMock.mockRejectedValue(new Error('no wifi adapter'))
      const result = await network.getWifiProfiles()
      expect(result).toEqual([])
    })

    it('uses Unknown security when detail fetch fails', async () => {
      execFileMock
        .mockResolvedValueOnce({
          stdout: '    All User Profile     : TestNet\n',
          stderr: '',
        })
        .mockRejectedValueOnce(new Error('timeout'))

      const result = await network.getWifiProfiles()
      expect(result).toEqual([{ name: 'TestNet', security: 'Unknown' }])
    })
  })

  describe('deleteWifiProfile', () => {
    it('returns true on successful deletion', async () => {
      execFileMock.mockResolvedValue({ stdout: '', stderr: '' })
      const result = await network.deleteWifiProfile('TestNetwork')
      expect(result).toBe(true)
    })

    it('returns false when name contains quotes', async () => {
      const result = await network.deleteWifiProfile('Test"Network')
      expect(result).toBe(false)
      expect(execFileMock).not.toHaveBeenCalled()
    })

    it('returns false when name contains control characters', async () => {
      const result = await network.deleteWifiProfile('Test\x00Network')
      expect(result).toBe(false)
    })

    it('returns false on error', async () => {
      execFileMock.mockRejectedValue(new Error('profile not found'))
      const result = await network.deleteWifiProfile('NonExistent')
      expect(result).toBe(false)
    })
  })

  describe('clearArpCache', () => {
    it('returns true on success', async () => {
      execFileMock.mockResolvedValue({ stdout: '', stderr: '' })
      const result = await network.clearArpCache()
      expect(result).toBe(true)
    })

    it('returns false on error', async () => {
      execFileMock.mockRejectedValue(new Error('access denied'))
      const result = await network.clearArpCache()
      expect(result).toBe(false)
    })
  })
})
