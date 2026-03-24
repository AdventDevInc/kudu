import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.fn()

vi.mock('child_process', () => ({
  execFile: execFileMock,
}))

vi.mock('util', () => ({
  promisify: () => execFileMock,
}))

vi.mock('systeminformation', () => ({}))

const { createWin32Commands } = await import('./commands')

describe('win32 commands', () => {
  const cmds = createWin32Commands()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('shutdown', () => {
    it('calls shutdown.exe with /s and the given delay', async () => {
      execFileMock.mockResolvedValue({ stdout: '', stderr: '' })

      await cmds.shutdown(30)

      expect(execFileMock).toHaveBeenCalledWith(
        'shutdown.exe',
        ['/s', '/t', '30'],
        { windowsHide: true }
      )
    })
  })

  describe('restart', () => {
    it('calls shutdown.exe with /r and the given delay', async () => {
      execFileMock.mockResolvedValue({ stdout: '', stderr: '' })

      await cmds.restart(10)

      expect(execFileMock).toHaveBeenCalledWith(
        'shutdown.exe',
        ['/r', '/t', '10'],
        { windowsHide: true }
      )
    })
  })

  describe('getDnsServers', () => {
    it('parses DNS server entries from powershell output', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify([
          { InterfaceAlias: 'Ethernet', ServerAddresses: ['8.8.8.8', '8.8.4.4'] },
          { InterfaceAlias: 'Wi-Fi', ServerAddresses: ['1.1.1.1'] },
        ]),
        stderr: '',
      })

      const result = await cmds.getDnsServers()

      expect(result).toEqual([
        { iface: 'Ethernet', servers: ['8.8.8.8', '8.8.4.4'] },
        { iface: 'Wi-Fi', servers: ['1.1.1.1'] },
      ])
    })

    it('handles single-object powershell output (not array)', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ InterfaceAlias: 'Ethernet', ServerAddresses: ['8.8.8.8'] }),
        stderr: '',
      })

      const result = await cmds.getDnsServers()
      expect(result).toEqual([{ iface: 'Ethernet', servers: ['8.8.8.8'] }])
    })

    it('filters out entries with no server addresses', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify([
          { InterfaceAlias: 'Loopback', ServerAddresses: [] },
          { InterfaceAlias: 'Ethernet', ServerAddresses: ['8.8.8.8'] },
        ]),
        stderr: '',
      })

      const result = await cmds.getDnsServers()
      expect(result).toHaveLength(1)
      expect(result[0].iface).toBe('Ethernet')
    })

    it('returns empty array on error', async () => {
      execFileMock.mockRejectedValue(new Error('timeout'))

      const result = await cmds.getDnsServers()
      expect(result).toEqual([])
    })
  })

  describe('getEventLog', () => {
    it('parses event log entries', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify([
          { time: '2024-01-01T00:00:00', id: 100, level: 'Warning', provider: 'TestProvider', message: 'Test message' },
        ]),
        stderr: '',
      })

      const result = await cmds.getEventLog('System', 10)

      expect(result).toEqual([{
        time: '2024-01-01T00:00:00',
        eventId: 100,
        level: 'Warning',
        provider: 'TestProvider',
        message: 'Test message',
      }])
    })

    it('sanitizes unknown log names to System', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ time: '2024-01-01', id: 1, level: null, provider: null, message: null }),
        stderr: '',
      })

      await cmds.getEventLog('MaliciousLog; rm -rf /', 50)

      // The command should use 'System' not the injected log name
      const callArgs = execFileMock.mock.calls[0]
      const psCommand = callArgs[1][callArgs[1].length - 1]
      expect(psCommand).toContain("'System'")
      expect(psCommand).not.toContain('MaliciousLog')
    })

    it('clamps maxEntries between 1 and 200', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify([]),
        stderr: '',
      })

      await cmds.getEventLog('System', 500)

      const callArgs = execFileMock.mock.calls[0]
      const psCommand = callArgs[1][callArgs[1].length - 1]
      expect(psCommand).toContain('-MaxEvents 200')
    })

    it('defaults to 50 when maxEntries is NaN', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify([]),
        stderr: '',
      })

      await cmds.getEventLog('System', NaN)

      const callArgs = execFileMock.mock.calls[0]
      const psCommand = callArgs[1][callArgs[1].length - 1]
      expect(psCommand).toContain('-MaxEvents 50')
    })

    it('defaults missing fields to sensible values', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ time: '2024-01-01', id: 1, level: null, provider: null, message: null }),
        stderr: '',
      })

      const result = await cmds.getEventLog('System', 1)

      expect(result[0].level).toBe('Information')
      expect(result[0].provider).toBe('')
      expect(result[0].message).toBe('')
    })
  })

  describe('getInstalledApps', () => {
    it('parses installed apps from powershell output', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify([
          { DisplayName: 'App1', DisplayVersion: '1.0', Publisher: 'Pub', InstallDate: '20240101', EstimatedSize: 1024 },
        ]),
        stderr: '',
      })

      const result = await cmds.getInstalledApps()

      expect(result).toEqual([{
        name: 'App1',
        version: '1.0',
        publisher: 'Pub',
        installDate: '20240101',
        sizeKb: 1024,
      }])
    })

    it('returns empty array for empty output', async () => {
      execFileMock.mockResolvedValue({ stdout: '  ', stderr: '' })

      const result = await cmds.getInstalledApps()
      expect(result).toEqual([])
    })

    it('handles single-object output', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ DisplayName: 'Solo', DisplayVersion: null, Publisher: null, InstallDate: null, EstimatedSize: null }),
        stderr: '',
      })

      const result = await cmds.getInstalledApps()
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        name: 'Solo',
        version: '',
        publisher: '',
        installDate: '',
        sizeKb: 0,
      })
    })
  })

  describe('checkOsUpdates', () => {
    it('parses available updates', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify([
          { Title: 'Security Update', KBArticleIDs: 'KB123', Severity: 'Critical', Size: 50000, IsDownloaded: true },
        ]),
        stderr: '',
      })

      const result = await cmds.checkOsUpdates()
      expect(result).toEqual([{
        title: 'Security Update',
        kb: 'KB123',
        severity: 'Critical',
        sizeBytes: 50000,
        downloaded: true,
      }])
    })

    it('returns empty array on error', async () => {
      execFileMock.mockRejectedValue(new Error('COM error'))
      const result = await cmds.checkOsUpdates()
      expect(result).toEqual([])
    })

    it('returns empty array for empty output', async () => {
      execFileMock.mockResolvedValue({ stdout: '  ', stderr: '' })
      const result = await cmds.checkOsUpdates()
      expect(result).toEqual([])
    })
  })

  describe('installOsUpdates', () => {
    it('parses successful install result', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ installed: 3, resultCode: 2, needsReboot: true }),
        stderr: '',
      })

      const result = await cmds.installOsUpdates()
      expect(result).toEqual({ installed: 3, resultCode: 2, needsReboot: true })
    })

    it('returns failure result on error', async () => {
      execFileMock.mockRejectedValue(new Error('access denied'))
      const result = await cmds.installOsUpdates()
      expect(result).toEqual({ installed: 0, resultCode: -1, needsReboot: false })
    })
  })

  describe('runSystemFileCheck', () => {
    it('returns clean status when no violations found', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ exitCode: 0, output: 'did not find any integrity violations' }),
        stderr: '',
      })

      const result = await cmds.runSystemFileCheck()
      expect(result).toEqual({ exitCode: 0, status: 'clean' })
    })

    it('returns repaired status', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ exitCode: 0, output: 'successfully repaired' }),
        stderr: '',
      })

      const result = await cmds.runSystemFileCheck()
      expect(result.status).toBe('repaired')
    })

    it('returns corrupt_unrepairable status', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ exitCode: 1, output: 'found corrupt files but was unable' }),
        stderr: '',
      })

      const result = await cmds.runSystemFileCheck()
      expect(result.status).toBe('corrupt_unrepairable')
    })

    it('returns failed status when could not perform', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ exitCode: 1, output: 'could not perform' }),
        stderr: '',
      })

      const result = await cmds.runSystemFileCheck()
      expect(result.status).toBe('failed')
    })

    it('returns unknown for unrecognized output', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ exitCode: 0, output: 'some unrecognized text' }),
        stderr: '',
      })

      const result = await cmds.runSystemFileCheck()
      expect(result.status).toBe('unknown')
    })

    it('returns failed on error', async () => {
      execFileMock.mockRejectedValue(new Error('timeout'))
      const result = await cmds.runSystemFileCheck()
      expect(result).toEqual({ exitCode: -1, status: 'failed' })
    })
  })

  describe('runSystemImageRepair', () => {
    it('returns success when restore completed successfully', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ exitCode: 0, output: 'The restore operation completed successfully' }),
        stderr: '',
      })

      const result = await cmds.runSystemImageRepair()
      expect(result).toEqual({ exitCode: 0, status: 'success' })
    })

    it('returns corrupt when component store corruption detected', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ exitCode: 1, output: 'component store corruption' }),
        stderr: '',
      })

      const result = await cmds.runSystemImageRepair()
      expect(result.status).toBe('corrupt')
    })

    it('returns clean when no component store corruption detected', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ exitCode: 0, output: 'No component store corruption detected' }),
        stderr: '',
      })

      const result = await cmds.runSystemImageRepair()
      expect(result.status).toBe('clean')
    })

    it('returns success for exit code 0 with unrecognized output', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ exitCode: 0, output: 'some other output' }),
        stderr: '',
      })

      const result = await cmds.runSystemImageRepair()
      expect(result.status).toBe('success')
    })

    it('returns unknown for non-zero exit with unrecognized output', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ exitCode: 2, output: 'something unexpected' }),
        stderr: '',
      })

      const result = await cmds.runSystemImageRepair()
      expect(result.status).toBe('unknown')
    })

    it('returns failed on error', async () => {
      execFileMock.mockRejectedValue(new Error('timeout'))
      const result = await cmds.runSystemImageRepair()
      expect(result).toEqual({ exitCode: -1, status: 'failed' })
    })
  })
})
