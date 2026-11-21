import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LINUX_HEADLESS_FLAGS,
  shouldRelaunchForHeadlessLinux,
  getHeadlessLinuxArgs,
  relaunchForHeadlessLinux
} from './headless-linux'

const mockSpawnSync = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({
  spawnSync: mockSpawnSync
}))

describe('headless Linux support (#614)', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const originalArgv = [...process.argv]
  const mockExit = vi.fn() as unknown as (code?: number) => never

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('KUDU_HEADLESS_REEXEC', '')
    vi.spyOn(process, 'exit').mockImplementation(mockExit)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    Object.defineProperty(process, 'platform', originalPlatform)
    process.argv = [...originalArgv]
  })

  describe('shouldRelaunchForHeadlessLinux', () => {
    it('returns false on non-Linux platforms', () => {
      expect(shouldRelaunchForHeadlessLinux('win32', ['kudu', '--cli'])).toBe(false)
      expect(shouldRelaunchForHeadlessLinux('darwin', ['kudu', '--cli'])).toBe(false)
    })

    it('returns false on Linux when not running in headless mode (GUI launch)', () => {
      expect(shouldRelaunchForHeadlessLinux('linux', ['kudu'])).toBe(false)
      expect(shouldRelaunchForHeadlessLinux('linux', ['kudu', '--minimized'])).toBe(false)
    })

    it('returns false on Linux when already marked as re-executed', () => {
      expect(
        shouldRelaunchForHeadlessLinux('linux', ['kudu', '--cli'], {
          KUDU_HEADLESS_REEXEC: '1'
        })
      ).toBe(false)
    })

    it('returns false on Linux when --ozone-platform is already present', () => {
      expect(
        shouldRelaunchForHeadlessLinux('linux', [
          'kudu',
          '--ozone-platform=headless',
          '--cli',
          'scan'
        ])
      ).toBe(false)
      expect(
        shouldRelaunchForHeadlessLinux('linux', [
          'kudu',
          '--ozone-platform=wayland',
          '--cli',
          'scan'
        ])
      ).toBe(false)
    })

    it('returns true on Linux when running --cli without --ozone-platform', () => {
      expect(
        shouldRelaunchForHeadlessLinux('linux', [
          '/opt/Kudu/kudu',
          '--cli',
          'scan',
          '--system',
          '--json'
        ])
      ).toBe(true)
    })

    it('returns true on Linux when running --daemon without --ozone-platform', () => {
      expect(shouldRelaunchForHeadlessLinux('linux', ['/opt/Kudu/kudu', '--daemon'])).toBe(true)
    })
  })

  describe('getHeadlessLinuxArgs', () => {
    it('prepends all headless flags when none are present', () => {
      const argv = ['/opt/Kudu/kudu', '--cli', 'scan', '--json']
      const args = getHeadlessLinuxArgs(argv)

      expect(args).toEqual([
        '--ozone-platform=headless',
        '--no-sandbox',
        '--disable-gpu',
        '--cli',
        'scan',
        '--json'
      ])
    })

    it('does not duplicate existing flags like --no-sandbox or --disable-gpu', () => {
      const argv = ['/opt/Kudu/kudu', '--no-sandbox', '--disable-gpu', '--cli', 'clean']
      const args = getHeadlessLinuxArgs(argv)

      expect(args).toEqual([
        '--ozone-platform=headless',
        '--no-sandbox',
        '--disable-gpu',
        '--cli',
        'clean'
      ])
    })

    it('preserves existing flags and custom arguments in order', () => {
      const argv = [
        'kudu',
        '--kudu-data-dir=/tmp/test',
        '--cli',
        'scan',
        '--system',
        '--browser',
        '--app',
        '--json'
      ]
      const args = getHeadlessLinuxArgs(argv)

      expect(args).toEqual([
        '--ozone-platform=headless',
        '--no-sandbox',
        '--disable-gpu',
        '--kudu-data-dir=/tmp/test',
        '--cli',
        'scan',
        '--system',
        '--browser',
        '--app',
        '--json'
      ])
    })
  })

  describe('relaunchForHeadlessLinux', () => {
    it('does nothing when shouldRelaunchForHeadlessLinux returns false', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      process.argv = ['kudu', '--cli', 'scan']

      relaunchForHeadlessLinux()

      expect(mockSpawnSync).not.toHaveBeenCalled()
      expect(process.exit).not.toHaveBeenCalled()
    })

    it('spawns child process with headless flags and exits with child status', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      process.argv = ['/opt/Kudu/kudu', '--cli', 'scan', '--json']
      mockSpawnSync.mockReturnValue({
        status: 0,
        signal: null,
        error: null
      })

      relaunchForHeadlessLinux()

      expect(mockSpawnSync).toHaveBeenCalledWith(
        process.execPath,
        ['--ozone-platform=headless', '--no-sandbox', '--disable-gpu', '--cli', 'scan', '--json'],
        expect.objectContaining({
          stdio: 'inherit',
          env: expect.objectContaining({
            KUDU_HEADLESS_REEXEC: '1'
          })
        })
      )
      expect(process.exit).toHaveBeenCalledWith(0)
    })

    it('propagates child process non-zero exit code', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      process.argv = ['/opt/Kudu/kudu', '--cli', 'scan']
      mockSpawnSync.mockReturnValue({
        status: 2,
        signal: null,
        error: null
      })

      relaunchForHeadlessLinux()

      expect(process.exit).toHaveBeenCalledWith(2)
    })

    it('exits with 130 on SIGINT signal', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      process.argv = ['/opt/Kudu/kudu', '--cli', 'scan']
      mockSpawnSync.mockReturnValue({
        status: null,
        signal: 'SIGINT',
        error: null
      })

      relaunchForHeadlessLinux()

      expect(process.exit).toHaveBeenCalledWith(130)
    })

    it('exits with 143 on SIGTERM signal', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      process.argv = ['/opt/Kudu/kudu', '--cli', 'scan']
      mockSpawnSync.mockReturnValue({
        status: null,
        signal: 'SIGTERM',
        error: null
      })

      relaunchForHeadlessLinux()

      expect(process.exit).toHaveBeenCalledWith(143)
    })

    it('handles spawn error gracefully and exits with code 1', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      process.argv = ['/opt/Kudu/kudu', '--cli', 'scan']
      mockSpawnSync.mockReturnValue({
        status: null,
        signal: null,
        error: new Error('spawn EACCES')
      })

      relaunchForHeadlessLinux()

      expect(console.error).toHaveBeenCalledWith(
        'Failed to spawn headless Kudu process:',
        expect.any(Error)
      )
      expect(process.exit).toHaveBeenCalledWith(1)
    })
  })
})
