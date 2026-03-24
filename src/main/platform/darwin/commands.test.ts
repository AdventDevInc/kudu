import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.fn()
vi.mock('child_process', () => ({
  execFile: execFileMock,
}))
vi.mock('util', () => ({
  promisify: (fn: any) => fn,
}))

const { createDarwinCommands } = await import('./commands')

describe('darwin commands', () => {
  const commands = createDarwinCommands()

  beforeEach(() => {
    vi.clearAllMocks()
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' })
  })

  describe('shutdown', () => {
    it('calls shutdown -h now for 0-second delay', async () => {
      await commands.shutdown(0)
      expect(execFileMock).toHaveBeenCalledWith('/sbin/shutdown', ['-h', 'now'])
    })

    it('converts seconds to minutes (rounds up)', async () => {
      await commands.shutdown(90)
      expect(execFileMock).toHaveBeenCalledWith('/sbin/shutdown', ['-h', '+2'])
    })

    it('rounds up partial minutes', async () => {
      await commands.shutdown(61)
      expect(execFileMock).toHaveBeenCalledWith('/sbin/shutdown', ['-h', '+2'])
    })

    it('treats 60 seconds as 1 minute', async () => {
      await commands.shutdown(60)
      expect(execFileMock).toHaveBeenCalledWith('/sbin/shutdown', ['-h', '+1'])
    })

    it('treats negative delay as now', async () => {
      await commands.shutdown(-10)
      expect(execFileMock).toHaveBeenCalledWith('/sbin/shutdown', ['-h', 'now'])
    })
  })

  describe('restart', () => {
    it('calls shutdown -r now for 0-second delay', async () => {
      await commands.restart(0)
      expect(execFileMock).toHaveBeenCalledWith('/sbin/shutdown', ['-r', 'now'])
    })

    it('converts seconds to minutes', async () => {
      await commands.restart(120)
      expect(execFileMock).toHaveBeenCalledWith('/sbin/shutdown', ['-r', '+2'])
    })
  })

  describe('getDnsServers', () => {
    it('parses scutil --dns output with multiple resolvers', async () => {
      execFileMock.mockResolvedValue({
        stdout: [
          'resolver #1',
          '  nameserver[0] : 8.8.8.8',
          '  nameserver[1] : 8.8.4.4',
          'resolver #2',
          '  nameserver[0] : 1.1.1.1',
        ].join('\n'),
      })

      const entries = await commands.getDnsServers()
      expect(entries).toHaveLength(2)
      expect(entries[0]).toEqual({ iface: 'resolver 1', servers: ['8.8.8.8', '8.8.4.4'] })
      expect(entries[1]).toEqual({ iface: 'resolver 2', servers: ['1.1.1.1'] })
    })

    it('returns empty array on failure', async () => {
      execFileMock.mockRejectedValue(new Error('not found'))
      const entries = await commands.getDnsServers()
      expect(entries).toEqual([])
    })

    it('skips resolvers with no nameservers', async () => {
      execFileMock.mockResolvedValue({
        stdout: [
          'resolver #1',
          '  domain: local',
          'resolver #2',
          '  nameserver[0] : 10.0.0.1',
        ].join('\n'),
      })

      const entries = await commands.getDnsServers()
      expect(entries).toHaveLength(1)
      expect(entries[0].iface).toBe('resolver 2')
    })
  })

  describe('getEventLog', () => {
    it('parses JSON log output and slices to maxEntries', async () => {
      const logs = [
        { timestamp: '2025-01-01', messageType: 'Error', subsystem: 'com.test', eventMessage: 'fail' },
        { timestamp: '2025-01-02', messageType: 'Fault', subsystem: 'com.test2', eventMessage: 'crash' },
        { timestamp: '2025-01-03', messageType: 'Info', subsystem: 'com.test3', eventMessage: 'ok' },
      ]
      execFileMock.mockResolvedValue({ stdout: JSON.stringify(logs) })

      const entries = await commands.getEventLog('System', 2)
      expect(entries).toHaveLength(2)
      expect(entries[0].provider).toBe('com.test')
      expect(entries[1].provider).toBe('com.test2')
    })

    it('uses System predicate for unknown log names', async () => {
      execFileMock.mockResolvedValue({ stdout: '[]' })
      await commands.getEventLog('UnknownLog', 10)
      const args = execFileMock.mock.calls[0][1]
      const predicateIdx = args.indexOf('--predicate')
      expect(predicateIdx).toBeGreaterThan(-1)
      expect(args[predicateIdx + 1]).toContain('com.apple')
    })

    it('returns empty array on exec failure', async () => {
      execFileMock.mockRejectedValue(new Error('fail'))
      const entries = await commands.getEventLog('System', 10)
      expect(entries).toEqual([])
    })

    it('returns empty array on invalid JSON', async () => {
      execFileMock.mockResolvedValue({ stdout: 'not json {{{' })
      const entries = await commands.getEventLog('System', 10)
      expect(entries).toEqual([])
    })

    it('truncates messages to 200 characters', async () => {
      const longMsg = 'a'.repeat(500)
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify([{ timestamp: 't', messageType: 'Info', subsystem: 's', eventMessage: longMsg }]),
      })
      const entries = await commands.getEventLog('System', 10)
      expect(entries[0].message).toHaveLength(200)
    })
  })

  describe('getInstalledApps', () => {
    it('parses system_profiler output, filters Apple apps, and computes sizes via du', async () => {
      execFileMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === '/usr/sbin/system_profiler') {
          return Promise.resolve({
            stdout: JSON.stringify({
              SPApplicationsDataType: [
                { _name: 'Safari', version: '17.0', obtained_from: 'apple', lastModified: '2025-01-01', path: '/Applications/Safari.app' },
                { _name: 'Slack', version: '4.0', obtained_from: 'identified_developer', lastModified: '2025-02-01', path: '/Applications/Slack.app' },
                { _name: 'Firefox', version: '120.0', obtained_from: 'identified_developer', lastModified: '2025-03-01', path: '/Applications/Firefox.app' },
              ],
            }),
          })
        }
        if (cmd === '/usr/bin/du') {
          return Promise.resolve({
            stdout: '524288\t/Applications/Slack.app\n102400\t/Applications/Firefox.app\n',
          })
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const apps = await commands.getInstalledApps()
      expect(apps).toHaveLength(2)
      expect(apps[0].name).toBe('Slack')
      expect(apps[0].sizeKb).toBe(524288)
      expect(apps[1].name).toBe('Firefox')
      expect(apps[1].sizeKb).toBe(102400)
    })

    it('handles du failure gracefully and returns 0 for sizes', async () => {
      execFileMock.mockImplementation((cmd: string) => {
        if (cmd === '/usr/sbin/system_profiler') {
          return Promise.resolve({
            stdout: JSON.stringify({
              SPApplicationsDataType: [
                { _name: 'Slack', version: '4.0', obtained_from: 'identified_developer', lastModified: '2025-02-01', path: '/Applications/Slack.app' },
              ],
            }),
          })
        }
        if (cmd === '/usr/bin/du') {
          return Promise.reject(new Error('permission denied'))
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const apps = await commands.getInstalledApps()
      expect(apps).toHaveLength(1)
      expect(apps[0].sizeKb).toBe(0)
    })

    it('parses partial du output from error object', async () => {
      execFileMock.mockImplementation((cmd: string) => {
        if (cmd === '/usr/sbin/system_profiler') {
          return Promise.resolve({
            stdout: JSON.stringify({
              SPApplicationsDataType: [
                { _name: 'Slack', version: '4.0', obtained_from: 'identified_developer', lastModified: '2025-02-01', path: '/Applications/Slack.app' },
              ],
            }),
          })
        }
        if (cmd === '/usr/bin/du') {
          const err: any = new Error('partial failure')
          err.stdout = '524288\t/Applications/Slack.app\n'
          return Promise.reject(err)
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const apps = await commands.getInstalledApps()
      expect(apps).toHaveLength(1)
      expect(apps[0].sizeKb).toBe(524288)
    })

    it('returns empty array on system_profiler failure', async () => {
      execFileMock.mockRejectedValue(new Error('fail'))
      const apps = await commands.getInstalledApps()
      expect(apps).toEqual([])
    })
  })

  describe('checkOsUpdates', () => {
    it('parses softwareupdate -l output', async () => {
      execFileMock.mockResolvedValue({
        stdout: [
          'Software Update found the following new or updated software:',
          '   * Label: macOS Sequoia 15.2',
          '     Size: 1.5G',
          '   * Label: Safari Update',
          '     Size: 100M',
        ].join('\n'),
      })

      const updates = await commands.checkOsUpdates()
      expect(updates).toHaveLength(2)
      expect(updates[0].title).toBe('macOS Sequoia 15.2')
      expect(updates[0].sizeBytes).toBe(1.5 * 1024 * 1024 * 1024)
      expect(updates[1].sizeBytes).toBe(100 * 1024 * 1024)
    })

    it('handles K size unit', async () => {
      execFileMock.mockResolvedValue({
        stdout: '   * Label: Small Update\n     Size: 500K\n',
      })
      const updates = await commands.checkOsUpdates()
      expect(updates[0].sizeBytes).toBe(500 * 1024)
    })

    it('handles bare numeric size (no unit)', async () => {
      execFileMock.mockResolvedValue({
        stdout: '   * Label: Tiny Update\n     Size: 1024\n',
      })
      const updates = await commands.checkOsUpdates()
      expect(updates[0].sizeBytes).toBe(1024)
    })

    it('returns empty array on failure', async () => {
      execFileMock.mockRejectedValue(new Error('fail'))
      const updates = await commands.checkOsUpdates()
      expect(updates).toEqual([])
    })
  })

  describe('installOsUpdates', () => {
    it('returns needsReboot true when stdout contains restart', async () => {
      execFileMock.mockResolvedValue({ stdout: 'Done. Please restart your computer.' })
      const result = await commands.installOsUpdates()
      expect(result.needsReboot).toBe(true)
      expect(result.installed).toBe(1)
      expect(result.resultCode).toBe(0)
    })

    it('returns needsReboot false when no restart mentioned', async () => {
      execFileMock.mockResolvedValue({ stdout: 'Done.' })
      const result = await commands.installOsUpdates()
      expect(result.needsReboot).toBe(false)
    })

    it('returns error result on failure', async () => {
      execFileMock.mockRejectedValue(new Error('fail'))
      const result = await commands.installOsUpdates()
      expect(result.installed).toBe(0)
      expect(result.resultCode).toBe(-1)
      expect(result.needsReboot).toBe(false)
    })
  })

  describe('runSystemFileCheck', () => {
    it('returns null (not supported on macOS)', async () => {
      const result = await commands.runSystemFileCheck()
      expect(result).toBeNull()
    })
  })

  describe('runSystemImageRepair', () => {
    it('returns null (not supported on macOS)', async () => {
      const result = await commands.runSystemImageRepair()
      expect(result).toBeNull()
    })
  })
})
