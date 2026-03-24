import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.fn()
vi.mock('child_process', () => ({
  execFile: execFileMock,
}))
vi.mock('util', () => ({
  promisify: (fn: any) => fn,
}))

const { createDarwinServices } = await import('./services')

describe('darwin services', () => {
  const services = createDarwinServices()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('scan', () => {
    it('parses launchctl list output and excludes Apple services', async () => {
      execFileMock.mockResolvedValue({
        stdout: [
          'PID\tStatus\tLabel',
          '123\t0\tcom.apple.Finder',
          '456\t0\tcom.docker.vmnetd',
          '-\t0\torg.homebrew.mxcl.postgresql',
        ].join('\n'),
      })

      const result = await services.scan()
      expect(result.services).toHaveLength(2)
      expect(result.services[0].name).toBe('com.docker.vmnetd')
      expect(result.services[0].status).toBe('Running')
      expect(result.services[1].name).toBe('org.homebrew.mxcl.postgresql')
      expect(result.services[1].status).toBe('Stopped')
    })

    it('counts running and disabled services', async () => {
      execFileMock.mockResolvedValue({
        stdout: [
          'PID\tStatus\tLabel',
          '100\t0\tcom.docker.vmnetd',
          '-\t0\torg.test.stopped',
          '200\t0\tio.another.running',
        ].join('\n'),
      })

      const result = await services.scan()
      expect(result.runningCount).toBe(2)
      expect(result.disabledCount).toBe(1)
      expect(result.totalCount).toBe(3)
    })

    it('skips Apple services (com.apple.*)', async () => {
      execFileMock.mockResolvedValue({
        stdout: [
          'PID\tStatus\tLabel',
          '1\t0\tcom.apple.Spotlight',
          '2\t0\tcom.apple.Dock',
          '3\t0\tcom.third.party',
        ].join('\n'),
      })

      const result = await services.scan()
      expect(result.services).toHaveLength(1)
      expect(result.services[0].name).toBe('com.third.party')
    })

    it('skips lines starting with [', async () => {
      execFileMock.mockResolvedValue({
        stdout: [
          'PID\tStatus\tLabel',
          '-\t0\t[system]',
          '3\t0\tcom.third.party',
        ].join('\n'),
      })

      const result = await services.scan()
      expect(result.services).toHaveLength(1)
    })

    it('skips malformed lines with fewer than 3 tab-separated fields', async () => {
      execFileMock.mockResolvedValue({
        stdout: [
          'PID\tStatus\tLabel',
          'incomplete',
          '3\t0\tcom.valid.service',
        ].join('\n'),
      })

      const result = await services.scan()
      expect(result.services).toHaveLength(1)
    })

    it('calls onProgress callback during scan', async () => {
      execFileMock.mockResolvedValue({
        stdout: [
          'PID\tStatus\tLabel',
          '1\t0\tcom.test.one',
        ].join('\n'),
      })

      const onProgress = vi.fn()
      await services.scan(onProgress)
      expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'enumerating',
        currentService: 'com.test.one',
      }))
    })

    it('returns empty result on failure', async () => {
      execFileMock.mockRejectedValue(new Error('fail'))
      const result = await services.scan()
      expect(result.services).toEqual([])
      expect(result.totalCount).toBe(0)
    })

    it('sets all services to caution safety level', async () => {
      execFileMock.mockResolvedValue({
        stdout: 'PID\tStatus\tLabel\n1\t0\tcom.test.svc\n',
      })

      const result = await services.scan()
      expect(result.services[0].safety).toBe('caution')
    })

    it('reports safeToDisableCount as 0 (no services marked safe)', async () => {
      execFileMock.mockResolvedValue({
        stdout: 'PID\tStatus\tLabel\n1\t0\tcom.test.svc\n',
      })

      const result = await services.scan()
      expect(result.safeToDisableCount).toBe(0)
    })
  })

  describe('applyChanges', () => {
    it('disables a service via launchctl disable', async () => {
      execFileMock.mockResolvedValue({ stdout: '' })
      const result = await services.applyChanges([
        { name: 'com.test.svc', targetStartType: 'Disabled' },
      ])

      expect(execFileMock).toHaveBeenCalledWith(
        '/bin/launchctl',
        expect.arrayContaining(['disable']),
        expect.objectContaining({ timeout: 10_000 }),
      )
      expect(result.succeeded).toBe(1)
      expect(result.failed).toBe(0)
    })

    it('enables a service via launchctl enable', async () => {
      execFileMock.mockResolvedValue({ stdout: '' })
      const result = await services.applyChanges([
        { name: 'com.test.svc', targetStartType: 'Automatic' },
      ])

      expect(execFileMock).toHaveBeenCalledWith(
        '/bin/launchctl',
        expect.arrayContaining(['enable']),
        expect.objectContaining({ timeout: 10_000 }),
      )
      expect(result.succeeded).toBe(1)
    })

    it('reports errors for failed changes', async () => {
      execFileMock.mockRejectedValue(new Error('permission denied'))
      const result = await services.applyChanges([
        { name: 'com.test.svc', targetStartType: 'Disabled' },
      ])

      expect(result.succeeded).toBe(0)
      expect(result.failed).toBe(1)
      expect(result.errors[0].name).toBe('com.test.svc')
      expect(result.errors[0].reason).toContain('permission denied')
    })

    it('handles mixed success and failure', async () => {
      execFileMock
        .mockResolvedValueOnce({ stdout: '' })
        .mockRejectedValueOnce(new Error('fail'))

      const result = await services.applyChanges([
        { name: 'com.good.svc', targetStartType: 'Disabled' },
        { name: 'com.bad.svc', targetStartType: 'Disabled' },
      ])

      expect(result.succeeded).toBe(1)
      expect(result.failed).toBe(1)
    })

    it('handles empty changes array', async () => {
      const result = await services.applyChanges([])
      expect(result.succeeded).toBe(0)
      expect(result.failed).toBe(0)
      expect(result.errors).toEqual([])
    })
  })
})
