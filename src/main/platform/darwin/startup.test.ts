import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join, resolve, normalize } from 'path'

const execFileMock = vi.fn()
const readdirMock = vi.fn()
const unlinkMock = vi.fn()
const existsSyncMock = vi.fn()

vi.mock('child_process', () => ({
  execFile: execFileMock,
}))
vi.mock('util', () => ({
  promisify: (fn: any) => fn,
}))
vi.mock('fs/promises', () => ({
  readdir: readdirMock,
  readFile: vi.fn(),
  unlink: unlinkMock,
}))
vi.mock('fs', () => ({
  existsSync: existsSyncMock,
}))
vi.mock('os', () => ({
  homedir: () => '/Users/TestUser',
}))
vi.mock('crypto', () => ({
  randomUUID: () => 'test-uuid-1234',
}))

const { createDarwinStartup } = await import('./startup')

// Build paths the same way the source does: join(resolve(homedir()), 'Library', 'LaunchAgents')
const USER_AGENTS_DIR = join(resolve('/Users/TestUser'), 'Library', 'LaunchAgents')
const GLOBAL_AGENTS_DIR = resolve('/Library/LaunchAgents')

describe('darwin startup', () => {
  const startup = createDarwinStartup()

  beforeEach(() => {
    vi.clearAllMocks()
    existsSyncMock.mockReturnValue(false)
    execFileMock.mockRejectedValue(new Error('not available'))
  })

  describe('listItems', () => {
    it('lists user launch agents from plist files', async () => {
      existsSyncMock.mockImplementation((dir: string) =>
        dir === USER_AGENTS_DIR,
      )
      readdirMock.mockResolvedValue(['com.example.app.plist', 'notaplist.txt'])
      execFileMock.mockImplementation((cmd: string) => {
        if (cmd === '/usr/bin/plutil') {
          return Promise.resolve({
            stdout: JSON.stringify({
              Label: 'com.example.app',
              Disabled: false,
              Program: '/usr/local/bin/example',
            }),
          })
        }
        return Promise.reject(new Error('skip'))
      })

      const items = await startup.listItems()
      // Only plist files are parsed
      expect(items.some((i) => i.name === 'com.example.app')).toBe(true)
      expect(items.some((i) => i.name === 'notaplist')).toBe(false)
    })

    it('sets source to launch-agent-user for user agents', async () => {
      existsSyncMock.mockImplementation((dir: string) =>
        dir === USER_AGENTS_DIR,
      )
      readdirMock.mockResolvedValue(['com.test.plist'])
      execFileMock.mockImplementation((cmd: string) => {
        if (cmd === '/usr/bin/plutil') {
          return Promise.resolve({
            stdout: JSON.stringify({ Label: 'com.test' }),
          })
        }
        return Promise.reject(new Error('skip'))
      })

      const items = await startup.listItems()
      expect(items[0].source).toBe('launch-agent-user')
    })

    it('marks disabled agents as enabled: false', async () => {
      existsSyncMock.mockImplementation((dir: string) =>
        dir === USER_AGENTS_DIR,
      )
      readdirMock.mockResolvedValue(['com.disabled.plist'])
      execFileMock.mockImplementation((cmd: string) => {
        if (cmd === '/usr/bin/plutil') {
          return Promise.resolve({
            stdout: JSON.stringify({ Label: 'com.disabled', Disabled: true }),
          })
        }
        return Promise.reject(new Error('skip'))
      })

      const items = await startup.listItems()
      expect(items[0].enabled).toBe(false)
    })

    it('lists global launch agents', async () => {
      existsSyncMock.mockImplementation((dir: string) =>
        dir === GLOBAL_AGENTS_DIR,
      )
      readdirMock.mockResolvedValue(['com.global.plist'])
      execFileMock.mockImplementation((cmd: string) => {
        if (cmd === '/usr/bin/plutil') {
          return Promise.resolve({
            stdout: JSON.stringify({ Label: 'com.global', Program: '/sbin/test' }),
          })
        }
        return Promise.reject(new Error('skip'))
      })

      const items = await startup.listItems()
      expect(items.some((i) => i.source === 'launch-agent-global')).toBe(true)
    })

    it('lists login items from osascript', async () => {
      existsSyncMock.mockReturnValue(false)
      execFileMock.mockImplementation((cmd: string) => {
        if (cmd === '/usr/bin/osascript') {
          return Promise.resolve({ stdout: 'Spotify, Docker' })
        }
        return Promise.reject(new Error('skip'))
      })

      const items = await startup.listItems()
      expect(items).toHaveLength(2)
      expect(items[0].name).toBe('Spotify')
      expect(items[0].source).toBe('login-item')
      expect(items[1].name).toBe('Docker')
    })

    it('returns empty array when nothing is available', async () => {
      existsSyncMock.mockReturnValue(false)
      execFileMock.mockRejectedValue(new Error('fail'))
      const items = await startup.listItems()
      expect(items).toEqual([])
    })

    it('extracts publisher from reverse-DNS label', async () => {
      existsSyncMock.mockImplementation((dir: string) =>
        dir === USER_AGENTS_DIR,
      )
      readdirMock.mockResolvedValue(['com.jetbrains.toolbox.plist'])
      execFileMock.mockImplementation((cmd: string) => {
        if (cmd === '/usr/bin/plutil') {
          return Promise.resolve({
            stdout: JSON.stringify({ Label: 'com.jetbrains.toolbox' }),
          })
        }
        return Promise.reject(new Error('skip'))
      })

      const items = await startup.listItems()
      expect(items[0].publisher).toBe('jetbrains')
    })

    it('creates friendly display name from reverse-DNS label', async () => {
      existsSyncMock.mockImplementation((dir: string) =>
        dir === USER_AGENTS_DIR,
      )
      readdirMock.mockResolvedValue(['com.docker.helper.update.plist'])
      execFileMock.mockImplementation((cmd: string) => {
        if (cmd === '/usr/bin/plutil') {
          return Promise.resolve({
            stdout: JSON.stringify({ Label: 'com.docker.helper.update' }),
          })
        }
        return Promise.reject(new Error('skip'))
      })

      const items = await startup.listItems()
      // friendlyName strips first two parts: com.docker.helper.update -> helper.update
      expect(items[0].displayName).toBe('helper.update')
    })

    it('falls back to filename when Label is missing', async () => {
      existsSyncMock.mockImplementation((dir: string) =>
        dir === USER_AGENTS_DIR,
      )
      readdirMock.mockResolvedValue(['com.nolabel.plist'])
      execFileMock.mockImplementation((cmd: string) => {
        if (cmd === '/usr/bin/plutil') {
          return Promise.resolve({
            stdout: JSON.stringify({}),
          })
        }
        return Promise.reject(new Error('skip'))
      })

      const items = await startup.listItems()
      expect(items[0].name).toBe('com.nolabel')
    })
  })

  describe('toggleItem', () => {
    const userPlist = join(USER_AGENTS_DIR, 'com.test.plist')
    const globalPlist = join(GLOBAL_AGENTS_DIR, 'com.test.plist')

    beforeEach(() => {
      execFileMock.mockResolvedValue({ stdout: '' })
    })

    it('loads a launch agent when enabling', async () => {
      const result = await startup.toggleItem(
        'com.test', userPlist,
        '', 'launch-agent-user', true,
      )
      expect(result).toBe(true)
      expect(execFileMock).toHaveBeenCalledWith(
        '/bin/launchctl', ['load', userPlist],
        expect.any(Object),
      )
    })

    it('unloads a launch agent when disabling', async () => {
      const result = await startup.toggleItem(
        'com.test', userPlist,
        '', 'launch-agent-user', false,
      )
      expect(result).toBe(true)
      expect(execFileMock).toHaveBeenCalledWith(
        '/bin/launchctl', ['unload', userPlist],
        expect.any(Object),
      )
    })

    it('rejects paths outside allowed directories', async () => {
      const result = await startup.toggleItem(
        'evil', '/etc/evil.plist',
        '', 'launch-agent-user', true,
      )
      expect(result).toBe(false)
      expect(execFileMock).not.toHaveBeenCalled()
    })

    it('rejects path traversal attempts', async () => {
      const traversalPath = join(USER_AGENTS_DIR, '..', '..', 'evil.plist')
      const result = await startup.toggleItem(
        'evil', traversalPath,
        '', 'launch-agent-user', true,
      )
      expect(result).toBe(false)
    })

    it('adds a login item via osascript when enabling', async () => {
      const result = await startup.toggleItem('MyApp', 'Login Items', '', 'login-item', true)
      expect(result).toBe(true)
      expect(execFileMock).toHaveBeenCalledWith(
        '/usr/bin/osascript',
        expect.arrayContaining(['-e']),
        expect.any(Object),
      )
    })

    it('deletes a login item via osascript when disabling', async () => {
      const result = await startup.toggleItem('MyApp', 'Login Items', '', 'login-item', false)
      expect(result).toBe(true)
    })

    it('sanitizes login item names to prevent AppleScript injection', async () => {
      await startup.toggleItem('My"App\\Test', 'Login Items', '', 'login-item', true)
      const script = execFileMock.mock.calls[0][1][1]
      expect(script).not.toContain('"App')
      expect(script).not.toContain('\\')
    })

    it('returns false for unknown source types', async () => {
      const result = await startup.toggleItem('test', '/path', '', 'registry' as any, true)
      expect(result).toBe(false)
    })

    it('returns false on error', async () => {
      execFileMock.mockRejectedValue(new Error('fail'))
      const result = await startup.toggleItem(
        'com.test', userPlist,
        '', 'launch-agent-user', true,
      )
      expect(result).toBe(false)
    })

    it('allows global launch agent paths', async () => {
      const result = await startup.toggleItem(
        'com.test', globalPlist,
        '', 'launch-agent-global', true,
      )
      expect(result).toBe(true)
    })
  })

  describe('deleteItem', () => {
    const userPlist = join(USER_AGENTS_DIR, 'com.test.plist')

    beforeEach(() => {
      execFileMock.mockResolvedValue({ stdout: '' })
      unlinkMock.mockResolvedValue(undefined)
    })

    it('unloads and deletes a launch agent plist', async () => {
      const result = await startup.deleteItem(
        'com.test', userPlist,
        'launch-agent-user',
      )
      expect(result).toBe(true)
      expect(execFileMock).toHaveBeenCalledWith(
        '/bin/launchctl', ['unload', userPlist],
        expect.any(Object),
      )
      expect(unlinkMock).toHaveBeenCalledWith(userPlist)
    })

    it('still deletes the file if unload fails (already unloaded)', async () => {
      execFileMock.mockRejectedValue(new Error('already unloaded'))
      const result = await startup.deleteItem(
        'com.test', userPlist,
        'launch-agent-user',
      )
      expect(result).toBe(true)
      expect(unlinkMock).toHaveBeenCalled()
    })

    it('rejects paths outside allowed directories', async () => {
      const result = await startup.deleteItem('evil', '/etc/evil.plist', 'launch-agent-user')
      expect(result).toBe(false)
      expect(unlinkMock).not.toHaveBeenCalled()
    })

    it('deletes a login item via osascript', async () => {
      const result = await startup.deleteItem('MyApp', 'Login Items', 'login-item')
      expect(result).toBe(true)
      expect(execFileMock).toHaveBeenCalledWith(
        '/usr/bin/osascript',
        expect.arrayContaining(['-e']),
        expect.any(Object),
      )
    })

    it('returns false for unknown source types', async () => {
      const result = await startup.deleteItem('test', '/path', 'registry' as any)
      expect(result).toBe(false)
    })

    it('returns false on delete error', async () => {
      unlinkMock.mockRejectedValue(new Error('permission denied'))
      const result = await startup.deleteItem(
        'com.test', userPlist,
        'launch-agent-user',
      )
      expect(result).toBe(false)
    })
  })

  describe('getBootTrace', () => {
    it('returns unavailable boot trace', async () => {
      const trace = await startup.getBootTrace()
      expect(trace.available).toBe(false)
      expect(trace.entries).toEqual([])
      expect(trace.totalBootMs).toBe(0)
    })
  })
})
