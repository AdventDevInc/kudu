import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LINUX_HEADLESS_FLAGS,
  shouldRelaunchForHeadlessLinux,
  getHeadlessLinuxArgs,
  relaunchForHeadlessLinux
} from './headless-linux'

describe('headless Linux support (#614)', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const originalExecve = Object.getOwnPropertyDescriptor(process, 'execve')
  const originalArgv = process.argv
  const mockExecve = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'execve', { value: mockExecve, configurable: true })
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    Object.defineProperty(process, 'platform', originalPlatform)
    if (originalExecve) Object.defineProperty(process, 'execve', originalExecve)
    else delete process.execve
    process.argv = originalArgv
  })

  describe('shouldRelaunchForHeadlessLinux', () => {
    it('leaves Windows, macOS, and Linux GUI launches alone', () => {
      expect(shouldRelaunchForHeadlessLinux('win32', ['kudu', '--cli'])).toBe(false)
      expect(shouldRelaunchForHeadlessLinux('darwin', ['kudu', '--daemon'])).toBe(false)
      expect(shouldRelaunchForHeadlessLinux('linux', ['kudu'])).toBe(false)
      expect(shouldRelaunchForHeadlessLinux('linux', ['kudu', '--minimized'])).toBe(false)
    })

    it.each(['--cli', '--daemon'])('relaunches Linux %s without an Ozone flag', (mode) => {
      expect(shouldRelaunchForHeadlessLinux('linux', ['/opt/Kudu/kudu', mode])).toBe(true)
    })

    it.each(['headless', 'wayland', 'x11'])('preserves an explicit %s backend', (backend) => {
      expect(
        shouldRelaunchForHeadlessLinux('linux', ['kudu', `--ozone-platform=${backend}`, '--cli'])
      ).toBe(false)
      expect(
        shouldRelaunchForHeadlessLinux('linux', ['kudu', '--ozone-platform', backend, '--daemon'])
      ).toBe(false)
    })

    it('does not let an inherited recursion marker bypass headless setup', () => {
      vi.stubEnv('KUDU_HEADLESS_REEXEC', '1')
      expect(shouldRelaunchForHeadlessLinux('linux', ['kudu', '--cli'])).toBe(true)
    })
  })

  describe('getHeadlessLinuxArgs', () => {
    it('prepends native flags and preserves all packaged CLI arguments', () => {
      const argv = [
        '/opt/Kudu/kudu',
        '--kudu-data-dir=/tmp/kudu data',
        '--cli',
        'scan',
        '--system',
        '--browser',
        '--app',
        '--json'
      ]
      expect(getHeadlessLinuxArgs(argv)).toEqual([...LINUX_HEADLESS_FLAGS, ...argv.slice(1)])
    })

    it('preserves the application path in development launches', () => {
      const argv = ['/usr/bin/electron', '/home/user/Kudu project', '--cli', '--help']
      expect(getHeadlessLinuxArgs(argv)).toEqual([...LINUX_HEADLESS_FLAGS, ...argv.slice(1)])
    })

    it('does not duplicate flags or mutate argv', () => {
      const argv = Object.freeze(['kudu', '--no-sandbox', '--disable-gpu', '--cli', 'clean'])
      const args = getHeadlessLinuxArgs(argv)
      expect(args).toEqual(['--ozone-platform=headless', ...argv.slice(1)])
      expect(shouldRelaunchForHeadlessLinux('linux', ['kudu', ...args])).toBe(false)
    })

    it('leaves existing Ozone switches unchanged in either form', () => {
      for (const flags of [['--ozone-platform=x11'], ['--ozone-platform', 'wayland']]) {
        expect(getHeadlessLinuxArgs(['kudu', ...flags, '--cli'])).toEqual([
          '--no-sandbox',
          '--disable-gpu',
          ...flags,
          '--cli'
        ])
      }
    })
  })

  describe('relaunchForHeadlessLinux', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      process.argv = ['/opt/Kudu/kudu', '--cli', 'scan', '--json']
    })

    it('replaces the current process with argv[0], user arguments and the environment intact', () => {
      relaunchForHeadlessLinux()
      expect(mockExecve).toHaveBeenCalledExactlyOnceWith(
        process.execPath,
        [process.execPath, ...LINUX_HEADLESS_FLAGS, '--cli', 'scan', '--json'],
        process.env
      )
      expect(process.exit).not.toHaveBeenCalled()
    })

    it('does not re-execute a GUI launch or an already configured CLI', () => {
      process.argv = ['kudu']
      relaunchForHeadlessLinux()
      process.argv = ['kudu', '--ozone-platform=headless', '--cli']
      relaunchForHeadlessLinux()
      expect(mockExecve).not.toHaveBeenCalled()
    })

    it('does nothing on Windows even when execve is unavailable', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      Object.defineProperty(process, 'execve', { value: undefined, configurable: true })
      relaunchForHeadlessLinux()
      expect(process.exit).not.toHaveBeenCalled()
    })

    it('fails clearly if the runtime lacks execve', () => {
      Object.defineProperty(process, 'execve', { value: undefined, configurable: true })
      relaunchForHeadlessLinux()
      expect(console.error).toHaveBeenCalledWith(
        'Failed to relaunch headless Kudu process:',
        expect.any(Error)
      )
      expect(process.exit).toHaveBeenCalledWith(1)
    })

    it('exits on a replacement error', () => {
      const error = new Error('execve EACCES')
      mockExecve.mockImplementationOnce(() => {
        throw error
      })
      relaunchForHeadlessLinux()
      expect(console.error).toHaveBeenCalledWith('Failed to relaunch headless Kudu process:', error)
      expect(process.exit).toHaveBeenCalledWith(1)
    })
  })
})
