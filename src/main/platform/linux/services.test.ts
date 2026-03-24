import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExecFile = vi.fn()

vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}))
vi.mock('util', () => ({
  promisify: () => mockExecFile,
}))

const { createLinuxServices } = await import('./services')

describe('linux services', () => {
  const services = createLinuxServices()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('scan', () => {
    it('parses systemctl list-units output', async () => {
      const stdout = [
        'UNIT                     LOAD   ACTIVE   SUB     DESCRIPTION',
        'ssh.service              loaded active   running OpenBSD Secure Shell server',
        'cron.service             loaded active   running Regular background program processing daemon',
        'bluetooth.service        loaded inactive dead    Bluetooth service',
        '',
      ].join('\n')
      mockExecFile.mockResolvedValueOnce({ stdout, stderr: '' })

      const result = await services.scan()

      expect(result.services.length).toBe(3)
      expect(result.runningCount).toBe(2)
      expect(result.disabledCount).toBe(1)
      expect(result.totalCount).toBe(3)
    })

    it('strips .service suffix from names', async () => {
      const stdout = [
        'UNIT                     LOAD   ACTIVE   SUB     DESCRIPTION',
        'ssh.service              loaded active   running OpenBSD Secure Shell server',
        '',
      ].join('\n')
      mockExecFile.mockResolvedValueOnce({ stdout, stderr: '' })

      const result = await services.scan()

      expect(result.services[0].name).toBe('ssh')
      expect(result.services[0].displayName).toBe('ssh')
    })

    it('skips units with not-found load state', async () => {
      const stdout = [
        'UNIT                        LOAD       ACTIVE   SUB  DESCRIPTION',
        'missing.service             not-found  inactive dead missing.service',
        'ssh.service                 loaded     active   running OpenBSD Secure Shell server',
        '',
      ].join('\n')
      mockExecFile.mockResolvedValueOnce({ stdout, stderr: '' })

      const result = await services.scan()

      expect(result.services.length).toBe(1)
      expect(result.services[0].name).toBe('ssh')
    })

    it('skips lines with fewer than 4 columns', async () => {
      const stdout = [
        'UNIT     LOAD   ACTIVE   SUB     DESCRIPTION',
        'ssh.service loaded active running OpenBSD Secure Shell server',
        'bad line',
        '',
      ].join('\n')
      mockExecFile.mockResolvedValueOnce({ stdout, stderr: '' })

      const result = await services.scan()

      expect(result.services.length).toBe(1)
    })

    it('returns empty result when systemctl fails', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('not found'))

      const result = await services.scan()

      expect(result.services).toEqual([])
      expect(result.totalCount).toBe(0)
      expect(result.runningCount).toBe(0)
      expect(result.disabledCount).toBe(0)
    })

    it('reports progress via callback', async () => {
      const stdout = [
        'UNIT                     LOAD   ACTIVE   SUB     DESCRIPTION',
        'ssh.service              loaded active   running OpenBSD Secure Shell server',
        'cron.service             loaded active   running Regular background program processing daemon',
        '',
      ].join('\n')
      mockExecFile.mockResolvedValueOnce({ stdout, stderr: '' })

      const progress: any[] = []
      await services.scan((data) => progress.push(data))

      expect(progress.length).toBe(2)
      expect(progress[0].phase).toBe('enumerating')
      expect(progress[0].currentService).toContain('ssh')
    })

    it('sets default service properties', async () => {
      const stdout = [
        'UNIT                     LOAD   ACTIVE   SUB     DESCRIPTION',
        'ssh.service              loaded active   running OpenBSD Secure Shell server',
        '',
      ].join('\n')
      mockExecFile.mockResolvedValueOnce({ stdout, stderr: '' })

      const result = await services.scan()
      const svc = result.services[0]

      expect(svc.status).toBe('Running')
      expect(svc.startType).toBe('Manual')
      expect(svc.safety).toBe('caution')
      expect(svc.category).toBe('misc')
      expect(svc.isMicrosoft).toBe(false)
      expect(svc.selected).toBe(false)
    })

    it('marks inactive/dead services as Stopped', async () => {
      const stdout = [
        'UNIT                     LOAD   ACTIVE   SUB     DESCRIPTION',
        'bluetooth.service        loaded inactive dead    Bluetooth service',
        '',
      ].join('\n')
      mockExecFile.mockResolvedValueOnce({ stdout, stderr: '' })

      const result = await services.scan()

      expect(result.services[0].status).toBe('Stopped')
    })

    it('joins multi-word descriptions', async () => {
      const stdout = [
        'UNIT                     LOAD   ACTIVE   SUB     DESCRIPTION',
        'ssh.service              loaded active   running OpenBSD Secure Shell server',
        '',
      ].join('\n')
      mockExecFile.mockResolvedValueOnce({ stdout, stderr: '' })

      const result = await services.scan()

      expect(result.services[0].description).toBe('OpenBSD Secure Shell server')
    })
  })

  describe('applyChanges', () => {
    it('disables a service', async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' })

      const result = await services.applyChanges([
        { name: 'bluetooth', targetStartType: 'Disabled' },
      ])

      expect(mockExecFile).toHaveBeenCalledWith(
        '/usr/bin/systemctl', ['disable', 'bluetooth'], { timeout: 10_000 },
      )
      expect(result.succeeded).toBe(1)
      expect(result.failed).toBe(0)
    })

    it('enables a service', async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' })

      const result = await services.applyChanges([
        { name: 'bluetooth', targetStartType: 'Automatic' },
      ])

      expect(mockExecFile).toHaveBeenCalledWith(
        '/usr/bin/systemctl', ['enable', 'bluetooth'], { timeout: 10_000 },
      )
      expect(result.succeeded).toBe(1)
    })

    it('collects errors for failed changes', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('Permission denied'))

      const result = await services.applyChanges([
        { name: 'bluetooth', targetStartType: 'Disabled' },
      ])

      expect(result.succeeded).toBe(0)
      expect(result.failed).toBe(1)
      expect(result.errors[0].name).toBe('bluetooth')
      expect(result.errors[0].reason).toContain('Permission denied')
    })

    it('handles mixed success and failure', async () => {
      mockExecFile
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce({ stdout: '', stderr: '' })

      const result = await services.applyChanges([
        { name: 'svc1', targetStartType: 'Disabled' },
        { name: 'svc2', targetStartType: 'Disabled' },
        { name: 'svc3', targetStartType: 'Automatic' },
      ])

      expect(result.succeeded).toBe(2)
      expect(result.failed).toBe(1)
    })

    it('returns zero counts for empty input', async () => {
      const result = await services.applyChanges([])

      expect(result.succeeded).toBe(0)
      expect(result.failed).toBe(0)
      expect(result.errors).toEqual([])
    })
  })
})
