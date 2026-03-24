import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExecFile = vi.fn()
const mockReadFile = vi.fn()

vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}))
vi.mock('util', () => ({
  promisify: () => mockExecFile,
}))
vi.mock('fs/promises', () => ({
  readFile: (...args: any[]) => mockReadFile(...args),
}))

const { createLinuxCommands } = await import('./commands')

describe('linux commands', () => {
  const commands = createLinuxCommands()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('shutdown', () => {
    it('calls shutdown -h now when delay is 0', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' })

      await commands.shutdown(0)

      expect(mockExecFile).toHaveBeenCalledWith(
        '/sbin/shutdown', ['-h', 'now'],
      )
    })

    it('calls shutdown -h now for negative delay', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' })

      await commands.shutdown(-10)

      expect(mockExecFile).toHaveBeenCalledWith(
        '/sbin/shutdown', ['-h', 'now'],
      )
    })

    it('converts seconds to minutes (ceiling) for positive delay', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' })

      await commands.shutdown(90)

      expect(mockExecFile).toHaveBeenCalledWith(
        '/sbin/shutdown', ['-h', '+2'],
      )
    })

    it('rounds up to 1 minute for small delays', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' })

      await commands.shutdown(1)

      expect(mockExecFile).toHaveBeenCalledWith(
        '/sbin/shutdown', ['-h', '+1'],
      )
    })
  })

  describe('restart', () => {
    it('calls shutdown -r now when delay is 0', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' })

      await commands.restart(0)

      expect(mockExecFile).toHaveBeenCalledWith(
        '/sbin/shutdown', ['-r', 'now'],
      )
    })

    it('converts seconds to minutes for positive delay', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' })

      await commands.restart(120)

      expect(mockExecFile).toHaveBeenCalledWith(
        '/sbin/shutdown', ['-r', '+2'],
      )
    })
  })

  describe('getDnsServers', () => {
    it('parses resolvectl dns output', async () => {
      mockExecFile.mockResolvedValueOnce({
        stdout: 'Link 2 (eth0): 8.8.8.8 8.8.4.4\nLink 3 (wlan0): 1.1.1.1\n',
        stderr: '',
      })

      const result = await commands.getDnsServers()

      expect(result).toEqual([
        { iface: 'eth0', servers: ['8.8.8.8', '8.8.4.4'] },
        { iface: 'wlan0', servers: ['1.1.1.1'] },
      ])
    })

    it('falls back to /etc/resolv.conf when resolvectl fails', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('not found'))
      mockReadFile.mockResolvedValueOnce('nameserver 8.8.8.8\nnameserver 1.1.1.1\n')

      const result = await commands.getDnsServers()

      expect(result).toEqual([
        { iface: 'system', servers: ['8.8.8.8', '1.1.1.1'] },
      ])
    })

    it('returns empty array when both resolvectl and resolv.conf fail', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('not found'))
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'))

      const result = await commands.getDnsServers()

      expect(result).toEqual([])
    })

    it('ignores non-nameserver lines in resolv.conf', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('not found'))
      mockReadFile.mockResolvedValueOnce(
        '# comment\nsearch example.com\nnameserver 8.8.8.8\noptions ndots:5\n',
      )

      const result = await commands.getDnsServers()

      expect(result).toEqual([{ iface: 'system', servers: ['8.8.8.8'] }])
    })

    it('returns empty when resolvectl returns no matching lines', async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: 'Global:\n', stderr: '' })
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'))

      const result = await commands.getDnsServers()

      expect(result).toEqual([])
    })
  })

  describe('getEventLog', () => {
    it('parses journalctl JSON output', async () => {
      const journalLine = JSON.stringify({
        __REALTIME_TIMESTAMP: '1700000000000000',
        PRIORITY: '3',
        SYSLOG_IDENTIFIER: 'kernel',
        MESSAGE: 'Test message',
      })
      mockExecFile.mockResolvedValueOnce({ stdout: journalLine + '\n', stderr: '' })

      const result = await commands.getEventLog('system', 10)

      expect(result.length).toBe(1)
      expect(result[0].level).toBe('Error')
      expect(result[0].provider).toBe('kernel')
      expect(result[0].message).toBe('Test message')
      expect(result[0].eventId).toBe(0)
    })

    it('maps priority levels correctly', async () => {
      const lines = [
        JSON.stringify({ PRIORITY: '0', MESSAGE: 'emerg' }),
        JSON.stringify({ PRIORITY: '3', MESSAGE: 'err' }),
        JSON.stringify({ PRIORITY: '4', MESSAGE: 'warn' }),
        JSON.stringify({ PRIORITY: '6', MESSAGE: 'info' }),
        JSON.stringify({ PRIORITY: '7', MESSAGE: 'debug' }),
      ].join('\n')
      mockExecFile.mockResolvedValueOnce({ stdout: lines, stderr: '' })

      const result = await commands.getEventLog('system', 50)

      expect(result[0].level).toBe('Critical')
      expect(result[1].level).toBe('Error')
      expect(result[2].level).toBe('Warning')
      expect(result[3].level).toBe('Information')
      expect(result[4].level).toBe('Debug')
    })

    it('skips unparseable lines', async () => {
      mockExecFile.mockResolvedValueOnce({
        stdout: 'not json\n' + JSON.stringify({ PRIORITY: '6', MESSAGE: 'ok' }) + '\n',
        stderr: '',
      })

      const result = await commands.getEventLog('system', 10)

      expect(result.length).toBe(1)
      expect(result[0].message).toBe('ok')
    })

    it('returns empty array when journalctl fails', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('not available'))

      const result = await commands.getEventLog('system', 10)

      expect(result).toEqual([])
    })

    it('truncates messages to 200 characters', async () => {
      const longMessage = 'x'.repeat(300)
      const line = JSON.stringify({ PRIORITY: '6', MESSAGE: longMessage })
      mockExecFile.mockResolvedValueOnce({ stdout: line + '\n', stderr: '' })

      const result = await commands.getEventLog('system', 10)

      expect(result[0].message.length).toBe(200)
    })

    it('uses _COMM when SYSLOG_IDENTIFIER is absent', async () => {
      const line = JSON.stringify({ PRIORITY: '6', _COMM: 'myproc', MESSAGE: 'test' })
      mockExecFile.mockResolvedValueOnce({ stdout: line + '\n', stderr: '' })

      const result = await commands.getEventLog('system', 10)

      expect(result[0].provider).toBe('myproc')
    })
  })

  describe('getInstalledApps', () => {
    it('returns empty array when no package manager is found', async () => {
      mockExecFile.mockRejectedValue(new Error('not found'))

      const result = await commands.getInstalledApps()

      expect(result).toEqual([])
    })

    it('parses apt/dpkg-query output', async () => {
      // First call: detectPackageManager tries apt --version
      mockExecFile
        .mockResolvedValueOnce({ stdout: 'apt 2.4.0', stderr: '' }) // apt --version
        .mockResolvedValueOnce({
          stdout: 'vim\t2:8.2.0-1\t3200\nnano\t5.4-2\t800\n',
          stderr: '',
        })

      const result = await commands.getInstalledApps()

      expect(result.length).toBe(2)
      expect(result[0].name).toBe('vim')
      expect(result[0].sizeKb).toBe(3200)
      expect(result[1].name).toBe('nano')
    })

    it('parses pacman output', async () => {
      // detectPackageManager: apt fails, dnf fails, pacman succeeds
      mockExecFile
        .mockRejectedValueOnce(new Error('no apt'))  // /usr/bin/apt
        .mockRejectedValueOnce(new Error('no apt'))  // /bin/apt
        .mockRejectedValueOnce(new Error('no dnf'))  // /usr/bin/dnf
        .mockRejectedValueOnce(new Error('no dnf'))  // /bin/dnf
        .mockResolvedValueOnce({ stdout: 'pacman 6.0', stderr: '' }) // /usr/bin/pacman
        .mockResolvedValueOnce({
          stdout: 'linux 6.1.0-1\nbash 5.2.015-1\n',
          stderr: '',
        })

      const result = await commands.getInstalledApps()

      expect(result.length).toBe(2)
      expect(result[0].name).toBe('linux')
      expect(result[0].version).toBe('6.1.0-1')
      expect(result[0].sizeKb).toBe(0)
    })
  })

  describe('installOsUpdates', () => {
    it('returns failure when no package manager is found', async () => {
      mockExecFile.mockRejectedValue(new Error('not found'))

      const result = await commands.installOsUpdates()

      expect(result).toEqual({ installed: 0, resultCode: -1, needsReboot: false })
    })
  })

  describe('runSystemFileCheck', () => {
    it('returns null when no package manager is found', async () => {
      mockExecFile.mockRejectedValue(new Error('not found'))

      const result = await commands.runSystemFileCheck()

      expect(result).toBeNull()
    })

    it('runs apt-get clean for apt-based systems', async () => {
      mockExecFile
        .mockResolvedValueOnce({ stdout: 'apt 2.4.0', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' })

      const result = await commands.runSystemFileCheck()

      expect(result).toEqual({ exitCode: 0, status: 'clean' })
    })
  })

  describe('runSystemImageRepair', () => {
    it('returns null when no package manager is found', async () => {
      mockExecFile.mockRejectedValue(new Error('not found'))

      const result = await commands.runSystemImageRepair()

      expect(result).toBeNull()
    })

    it('runs apt-get autoremove for apt-based systems', async () => {
      mockExecFile
        .mockResolvedValueOnce({ stdout: 'apt 2.4.0', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' })

      const result = await commands.runSystemImageRepair()

      expect(result).toEqual({ exitCode: 0, status: 'success' })
    })
  })
})
