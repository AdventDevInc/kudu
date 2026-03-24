import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join, resolve } from 'path'

const mockExecFile = vi.fn()
const mockReaddir = vi.fn()
const mockReadFile = vi.fn()
const mockRename = vi.fn()
const mockExistsSync = vi.fn()

vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}))
vi.mock('util', () => ({
  promisify: () => mockExecFile,
}))
vi.mock('fs/promises', () => ({
  readdir: (...args: any[]) => mockReaddir(...args),
  readFile: (...args: any[]) => mockReadFile(...args),
  rename: (...args: any[]) => mockRename(...args),
}))
vi.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
}))
vi.mock('os', () => ({ homedir: () => '/home/testuser' }))
vi.mock('crypto', () => ({ randomUUID: () => 'test-uuid-1234' }))

const { createLinuxStartup } = await import('./startup')

// Build paths the same way the source does
const HOME = join('/home', 'testuser')
const AUTOSTART = resolve(join(HOME, '.config', 'autostart'))

describe('linux startup', () => {
  const startup = createLinuxStartup()

  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
  })

  describe('listItems', () => {
    it('returns empty array when no autostart dir and systemctl/crontab fail', async () => {
      mockExistsSync.mockReturnValue(false)
      mockExecFile.mockRejectedValue(new Error('not available'))

      const result = await startup.listItems()

      expect(result).toEqual([])
    })

    it('reads XDG autostart .desktop files', async () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddir.mockResolvedValueOnce(['slack.desktop', 'steam.desktop'])
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes('slack')) {
          return Promise.resolve(
            '[Desktop Entry]\nName=Slack\nExec=/usr/bin/slack\nComment=Slack Messaging\n',
          )
        }
        if (path.includes('steam')) {
          return Promise.resolve(
            '[Desktop Entry]\nName=Steam\nExec=/usr/bin/steam\nHidden=false\n',
          )
        }
        return Promise.reject(new Error('ENOENT'))
      })
      // systemctl and crontab fail
      mockExecFile.mockRejectedValue(new Error('not available'))

      const result = await startup.listItems()

      expect(result.length).toBe(2)
      expect(result[0].displayName).toBe('Slack')
      expect(result[0].command).toBe('/usr/bin/slack')
      expect(result[0].source).toBe('autostart-desktop')
      expect(result[0].enabled).toBe(true)
      expect(result[0].publisher).toBe('Slack Messaging')
    })

    it('marks .desktop.disabled files as disabled', async () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddir.mockResolvedValueOnce(['app.desktop.disabled'])
      mockReadFile.mockResolvedValueOnce(
        '[Desktop Entry]\nName=App\nExec=/usr/bin/app\n',
      )
      mockExecFile.mockRejectedValue(new Error('not available'))

      const result = await startup.listItems()

      expect(result.length).toBe(1)
      expect(result[0].enabled).toBe(false)
    })

    it('marks Hidden=true desktop entries as disabled', async () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddir.mockResolvedValueOnce(['app.desktop'])
      mockReadFile.mockResolvedValueOnce(
        '[Desktop Entry]\nName=App\nExec=/usr/bin/app\nHidden=true\n',
      )
      mockExecFile.mockRejectedValue(new Error('not available'))

      const result = await startup.listItems()

      expect(result.length).toBe(1)
      expect(result[0].enabled).toBe(false)
    })

    it('reads systemd user services', async () => {
      mockExistsSync.mockReturnValue(false)
      mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
        if (args?.includes('--user')) {
          return Promise.resolve({
            stdout: 'UNIT FILE                    STATE     VENDOR\npipewire.service             enabled   enabled\npulseaudio.service           disabled  disabled\n',
            stderr: '',
          })
        }
        return Promise.reject(new Error('not available'))
      })

      const result = await startup.listItems()

      expect(result.length).toBe(2)
      expect(result[0].displayName).toBe('pipewire')
      expect(result[0].source).toBe('systemd-user')
      expect(result[0].enabled).toBe(true)
      expect(result[1].displayName).toBe('pulseaudio')
      expect(result[1].enabled).toBe(false)
    })

    it('reads @reboot cron entries', async () => {
      mockExistsSync.mockReturnValue(false)
      mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
        if (args?.includes('-l')) {
          return Promise.resolve({
            stdout: '@reboot /usr/local/bin/myapp --daemon\n# regular cron job\n0 * * * * /usr/bin/something\n',
            stderr: '',
          })
        }
        return Promise.reject(new Error('not available'))
      })

      const result = await startup.listItems()

      expect(result.length).toBe(1)
      expect(result[0].source).toBe('cron')
      expect(result[0].command).toBe('/usr/local/bin/myapp --daemon')
      expect(result[0].enabled).toBe(true)
    })

    it('skips non-.desktop files in autostart directory', async () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddir.mockResolvedValueOnce(['readme.txt', 'app.desktop', 'config.json'])
      mockReadFile.mockResolvedValueOnce(
        '[Desktop Entry]\nName=App\nExec=/usr/bin/app\n',
      )
      mockExecFile.mockRejectedValue(new Error('not available'))

      const result = await startup.listItems()

      expect(result.length).toBe(1)
    })

    it('uses basename as fallback when Name field is missing', async () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddir.mockResolvedValueOnce(['unnamed.desktop'])
      mockReadFile.mockResolvedValueOnce('[Desktop Entry]\nExec=/usr/bin/app\n')
      mockExecFile.mockRejectedValue(new Error('not available'))

      const result = await startup.listItems()

      expect(result[0].displayName).toBe('unnamed')
    })
  })

  describe('toggleItem', () => {
    it('renames .disabled to enable an autostart-desktop item', async () => {
      mockRename.mockResolvedValueOnce(undefined)

      const location = join(AUTOSTART, 'app.desktop.disabled')
      const result = await startup.toggleItem(
        'app.desktop.disabled',
        location,
        '/usr/bin/app',
        'autostart-desktop',
        true,
      )

      expect(result).toBe(true)
      expect(mockRename).toHaveBeenCalledWith(
        location,
        join(AUTOSTART, 'app.desktop'),
      )
    })

    it('appends .disabled to disable an autostart-desktop item', async () => {
      mockRename.mockResolvedValueOnce(undefined)

      const location = join(AUTOSTART, 'app.desktop')
      const result = await startup.toggleItem(
        'app.desktop',
        location,
        '/usr/bin/app',
        'autostart-desktop',
        false,
      )

      expect(result).toBe(true)
      expect(mockRename).toHaveBeenCalledWith(
        location,
        location + '.disabled',
      )
    })

    it('rejects paths outside the autostart directory', async () => {
      const result = await startup.toggleItem(
        'evil',
        '/etc/passwd',
        '',
        'autostart-desktop',
        true,
      )

      expect(result).toBe(false)
      expect(mockRename).not.toHaveBeenCalled()
    })

    it('rejects path traversal attempts', async () => {
      const result = await startup.toggleItem(
        'evil',
        join(AUTOSTART, '..', '..', 'etc', 'passwd'),
        '',
        'autostart-desktop',
        true,
      )

      expect(result).toBe(false)
      expect(mockRename).not.toHaveBeenCalled()
    })

    it('does not rename if already in desired state (enable, no .disabled)', async () => {
      const location = join(AUTOSTART, 'app.desktop')
      const result = await startup.toggleItem(
        'app.desktop',
        location,
        '/usr/bin/app',
        'autostart-desktop',
        true,
      )

      expect(result).toBe(true)
      expect(mockRename).not.toHaveBeenCalled()
    })

    it('calls systemctl --user enable for systemd-user items', async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' })

      const result = await startup.toggleItem(
        'pipewire.service',
        'pipewire.service',
        '',
        'systemd-user',
        true,
      )

      expect(result).toBe(true)
      expect(mockExecFile).toHaveBeenCalledWith(
        '/usr/bin/systemctl', ['--user', 'enable', 'pipewire.service'],
        { timeout: 10_000 },
      )
    })

    it('calls systemctl --user disable for systemd-user items', async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' })

      const result = await startup.toggleItem(
        'pipewire.service',
        'pipewire.service',
        '',
        'systemd-user',
        false,
      )

      expect(result).toBe(true)
      expect(mockExecFile).toHaveBeenCalledWith(
        '/usr/bin/systemctl', ['--user', 'disable', 'pipewire.service'],
        { timeout: 10_000 },
      )
    })

    it('returns false for unsupported source types', async () => {
      const result = await startup.toggleItem(
        'something',
        'somewhere',
        '',
        'cron' as any,
        true,
      )

      expect(result).toBe(false)
    })

    it('returns false when rename fails', async () => {
      mockRename.mockRejectedValueOnce(new Error('EACCES'))

      const location = join(AUTOSTART, 'app.desktop')
      const result = await startup.toggleItem(
        'app.desktop',
        location,
        '/usr/bin/app',
        'autostart-desktop',
        false,
      )

      expect(result).toBe(false)
    })

    it('returns false when systemctl fails', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('Permission denied'))

      const result = await startup.toggleItem(
        'svc.service',
        'svc.service',
        '',
        'systemd-user',
        true,
      )

      expect(result).toBe(false)
    })
  })

  describe('getBootTrace', () => {
    it('returns unavailable boot trace', async () => {
      const result = await startup.getBootTrace()

      expect(result.available).toBe(false)
      expect(result.entries).toEqual([])
      expect(result.totalBootMs).toBe(0)
    })
  })
})
