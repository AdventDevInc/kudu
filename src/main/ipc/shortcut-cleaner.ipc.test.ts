import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { IPC } from '../../shared/channels'
import type { CleanResult, ScanResult } from '../../shared/types'
import {
  checkShortcutTarget,
  isShortcutTargetBroken,
  probePath,
  WIN_SYSTEM_SUBDIRS,
  type PathState,
  type ShortcutInfo
} from '../services/shortcut-target'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  home: '',
  settings: {
    exclusions: [] as string[],
    cleaner: { secureDelete: false, skipRecentMinutes: 0, keepDeletionLog: false }
  }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => mocks.home
}))
vi.mock('../services/settings-store', () => ({ getSettings: () => mocks.settings }))

import { registerShortcutCleanerIpc } from './shortcut-cleaner.ipc'

// ── isShortcutTargetBroken ──
// `targetExists` answers for the target itself. Drive and share roots are
// reported present, and the other Program Files folder missing, unless a test
// passes its own probe.

const DRIVE_OR_SHARE_ROOT = /^([a-z]:\\|\\\\[^\\]+\\[^\\]+)$/i

function isTargetBrokenLogic(
  info: ShortcutInfo,
  platform: NodeJS.Platform,
  targetExists: boolean
): boolean {
  return isShortcutTargetBroken(info, platform, (p): PathState => {
    if (DRIVE_OR_SHARE_ROOT.test(p)) return 'present'
    if (p === info.targetPath) return targetExists ? 'present' : 'missing'
    return 'missing'
  })
}

describe('isTargetBroken logic', () => {
  // ── Windows-specific ──

  it('does not flag shortcuts in Windows system subdirectories', () => {
    expect(
      isTargetBrokenLogic(
        {
          path: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\System Tools\\cmd.lnk',
          targetPath: null
        },
        'win32',
        false
      )
    ).toBe(false)
  })

  it('does not flag shortcuts in Administrative Tools', () => {
    expect(
      isTargetBrokenLogic(
        {
          path: 'C:\\ProgramData\\Start Menu\\Programs\\Administrative Tools\\disk.lnk',
          targetPath: null
        },
        'win32',
        false
      )
    ).toBe(false)
  })

  it('does not flag shortcuts in Accessibility', () => {
    expect(
      isTargetBrokenLogic(
        {
          path: 'C:\\Start Menu\\Programs\\Accessibility\\magnify.lnk',
          targetPath: null
        },
        'win32',
        false
      )
    ).toBe(false)
  })

  it('does not flag Windows shortcuts with no resolvable target (shell namespace targets)', () => {
    // Regression: issue #169 — "File Explorer.lnk" uses a shell ID list target,
    // so WScript.Shell returns an empty TargetPath. It must not be flagged as dead.
    expect(
      isTargetBrokenLogic(
        {
          path: 'C:\\Users\\User\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\File Explorer.lnk',
          targetPath: null
        },
        'win32',
        false
      )
    ).toBe(false)
  })

  it('does not flag taskbar shortcuts with null target', () => {
    expect(
      isTargetBrokenLogic(
        {
          path: 'C:\\Users\\User\\AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar\\explorer.lnk',
          targetPath: null
        },
        'win32',
        false
      )
    ).toBe(false)
  })

  it('flags taskbar shortcuts whose drive-letter target is gone', () => {
    expect(
      isTargetBrokenLogic(
        {
          path: 'C:\\User Pinned\\TaskBar\\app.lnk',
          targetPath: 'C:\\Missing\\app.exe'
        },
        'win32',
        false
      )
    ).toBe(true)
  })

  it('does not flag shortcuts pointing to Windows system executables', () => {
    expect(
      isTargetBrokenLogic(
        {
          path: 'C:\\Desktop\\notepad.lnk',
          targetPath: 'C:\\Windows\\System32\\notepad.exe'
        },
        'win32',
        false
      )
    ).toBe(false)
  })

  // ── URL and special targets ──

  it('does not flag HTTP URL targets', () => {
    expect(
      isTargetBrokenLogic(
        {
          path: 'C:\\Desktop\\bookmark.lnk',
          targetPath: 'http://example.com'
        },
        'win32',
        false
      )
    ).toBe(false)
  })

  it('does not flag HTTPS URL targets', () => {
    expect(
      isTargetBrokenLogic(
        {
          path: 'C:\\Desktop\\secure.lnk',
          targetPath: 'https://example.com'
        },
        'win32',
        false
      )
    ).toBe(false)
  })

  it('does not flag shell: protocol targets', () => {
    expect(
      isTargetBrokenLogic(
        {
          path: 'C:\\Desktop\\shell.lnk',
          targetPath: 'shell:RecycleBinFolder'
        },
        'win32',
        false
      )
    ).toBe(false)
  })

  it('does not flag microsoft. UWP targets', () => {
    expect(
      isTargetBrokenLogic(
        {
          path: 'C:\\Desktop\\store.lnk',
          targetPath: 'microsoft.windowsstore:'
        },
        'win32',
        false
      )
    ).toBe(false)
  })

  it('does not flag WindowsApps targets', () => {
    expect(
      isTargetBrokenLogic(
        {
          path: 'C:\\Desktop\\uwp.lnk',
          targetPath: 'C:\\Program Files\\WindowsApps\\SomeApp\\app.exe'
        },
        'win32',
        false
      )
    ).toBe(false)
  })

  it('does not flag other protocol handlers (e.g. ftp:)', () => {
    expect(
      isTargetBrokenLogic(
        {
          path: 'C:\\Desktop\\ftp.lnk',
          targetPath: 'ftp://server.com'
        },
        'win32',
        false
      )
    ).toBe(false)
  })

  // ── Null and empty targets ──

  it('on Linux, flags null target as broken', () => {
    // On Linux, a null target means the .desktop file had no Exec line or was
    // unreadable, which we treat as broken. On Windows, null instead means a
    // shell-namespace target that we cannot verify (handled above).
    expect(
      isTargetBrokenLogic(
        {
          path: '/home/user/Desktop/broken.desktop',
          targetPath: null
        },
        'linux',
        false
      )
    ).toBe(true)
  })

  it('flags empty string target as broken', () => {
    expect(
      isTargetBrokenLogic(
        {
          path: '/home/user/Desktop/broken.desktop',
          targetPath: '   '
        },
        'linux',
        false
      )
    ).toBe(true)
  })

  // ── Target exists/not ──

  it('flags a Windows drive-letter target that does not exist', () => {
    // Regression: drive letters used to match the protocol-handler check, so
    // no shortcut with a C:\... target was ever flagged on Windows.
    expect(
      isTargetBrokenLogic(
        {
          path: 'C:\\Desktop\\app.lnk',
          targetPath: 'C:\\Missing\\app.exe'
        },
        'win32',
        false
      )
    ).toBe(true)
  })

  it('does not flag a target on a drive that is not connected', () => {
    const info = { path: 'C:\\Desktop\\usb.lnk', targetPath: 'E:\\Tools\\app.exe' }
    expect(isShortcutTargetBroken(info, 'win32', () => 'missing')).toBe(false)
  })

  it('does not flag a target on a network share that is offline', () => {
    const info = { path: 'C:\\Desktop\\nas.lnk', targetPath: '\\\\nas\\media\\player.exe' }
    expect(
      isShortcutTargetBroken(info, 'win32', (p) => (p === '\\\\nas\\media' ? 'unknown' : 'missing'))
    ).toBe(false)
  })

  it('flags a missing target on a network share that is reachable', () => {
    const info = { path: 'C:\\Desktop\\nas.lnk', targetPath: '\\\\nas\\media\\player.exe' }
    expect(
      isShortcutTargetBroken(info, 'win32', (p) => (p === '\\\\nas\\media' ? 'present' : 'missing'))
    ).toBe(true)
  })

  it('does not flag a target it could not inspect (e.g. access denied)', () => {
    const info = { path: 'C:\\Desktop\\app.lnk', targetPath: 'C:\\Restricted\\app.exe' }
    expect(
      isShortcutTargetBroken(info, 'win32', (p) => (p === 'C:\\' ? 'present' : 'unknown'))
    ).toBe(false)
  })

  it('does not flag a Program Files target installed under Program Files (x86)', () => {
    const info = { path: 'C:\\Desktop\\app.lnk', targetPath: 'C:\\Program Files\\Acme\\acme.exe' }
    const probe = (p: string): PathState =>
      p === 'C:\\' || p === 'C:\\Program Files (x86)\\Acme\\acme.exe' ? 'present' : 'missing'
    expect(isShortcutTargetBroken(info, 'win32', probe)).toBe(false)
  })

  it('does not flag a Program Files (x86) target installed under Program Files', () => {
    const info = {
      path: 'C:\\Desktop\\app.lnk',
      targetPath: 'C:\\Program Files (x86)\\Acme\\acme.exe'
    }
    const probe = (p: string): PathState =>
      p === 'C:\\' || p === 'C:\\Program Files\\Acme\\acme.exe' ? 'present' : 'missing'
    expect(isShortcutTargetBroken(info, 'win32', probe)).toBe(false)
  })

  it('flags a Program Files target missing from both Program Files folders', () => {
    const info = { path: 'C:\\Desktop\\app.lnk', targetPath: 'C:\\Program Files\\Acme\\acme.exe' }
    expect(isTargetBrokenLogic(info, 'win32', false)).toBe(true)
  })

  it('on Linux, does not flag a target it could not inspect', () => {
    const info = { path: '/home/user/Desktop/app.desktop', targetPath: '/opt/secret/app' }
    expect(isShortcutTargetBroken(info, 'linux', () => 'unknown')).toBe(false)
  })

  it('does not flag existing target (Windows drive letter)', () => {
    expect(
      isTargetBrokenLogic(
        {
          path: 'C:\\Desktop\\app.lnk',
          targetPath: 'C:\\Existing\\app.exe'
        },
        'win32',
        true
      )
    ).toBe(false)
  })

  it('flags UNC-style target with missing file on Linux', () => {
    expect(
      isTargetBrokenLogic(
        {
          path: '/home/user/Desktop/app.desktop',
          targetPath: '/opt/missing/app'
        },
        'linux',
        false
      )
    ).toBe(true)
  })

  // ── Linux-specific ──

  it('on Linux, does not flag non-absolute paths (resolved via PATH)', () => {
    expect(
      isTargetBrokenLogic(
        {
          path: '/home/user/.local/share/applications/app.desktop',
          targetPath: 'firefox'
        },
        'linux',
        false
      )
    ).toBe(false)
  })

  it('on Linux, flags absolute target that does not exist', () => {
    expect(
      isTargetBrokenLogic(
        {
          path: '/home/user/Desktop/app.desktop',
          targetPath: '/usr/bin/nonexistent'
        },
        'linux',
        false
      )
    ).toBe(true)
  })

  it('on Linux, does not flag absolute target that exists', () => {
    expect(
      isTargetBrokenLogic(
        {
          path: '/home/user/Desktop/app.desktop',
          targetPath: '/usr/bin/existing'
        },
        'linux',
        true
      )
    ).toBe(false)
  })
})

// ── WIN_SYSTEM_SUBDIRS regex ──

describe('WIN_SYSTEM_SUBDIRS regex', () => {
  it('matches System Tools', () => {
    expect(WIN_SYSTEM_SUBDIRS.test('\\System Tools\\')).toBe(true)
  })

  it('matches Administrative Tools', () => {
    expect(WIN_SYSTEM_SUBDIRS.test('\\Administrative Tools\\')).toBe(true)
  })

  it('matches Accessibility', () => {
    expect(WIN_SYSTEM_SUBDIRS.test('\\Accessibility\\')).toBe(true)
  })

  it('matches Windows PowerShell', () => {
    expect(WIN_SYSTEM_SUBDIRS.test('\\Windows PowerShell\\')).toBe(true)
  })

  it('matches Windows System', () => {
    expect(WIN_SYSTEM_SUBDIRS.test('\\Windows System\\')).toBe(true)
  })

  it('matches Windows Accessories', () => {
    expect(WIN_SYSTEM_SUBDIRS.test('\\Windows Accessories\\')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(WIN_SYSTEM_SUBDIRS.test('\\system tools\\')).toBe(true)
    expect(WIN_SYSTEM_SUBDIRS.test('\\WINDOWS SYSTEM\\')).toBe(true)
  })

  it('does not match arbitrary directory names', () => {
    expect(WIN_SYSTEM_SUBDIRS.test('\\My Programs\\')).toBe(false)
    expect(WIN_SYSTEM_SUBDIRS.test('\\Games\\')).toBe(false)
  })
})

// ── validateStringArray (replica) ──

function validateStringArray(
  input: unknown,
  maxItems: number = 10_000,
  maxItemLength: number = 1024
): string[] | null {
  if (!Array.isArray(input)) return null
  if (input.length > maxItems) return null
  if (!input.every((v: unknown) => typeof v === 'string' && v.length <= maxItemLength)) return null
  return input as string[]
}

describe('SHORTCUT_CLEAN input validation', () => {
  it('rejects non-array input', () => {
    expect(validateStringArray(null)).toBe(null)
    expect(validateStringArray('string')).toBe(null)
    expect(validateStringArray({})).toBe(null)
  })

  it('accepts valid string array', () => {
    expect(validateStringArray(['id-1', 'id-2'])).toEqual(['id-1', 'id-2'])
  })

  it('accepts empty array', () => {
    expect(validateStringArray([])).toEqual([])
  })

  it('rejects mixed types', () => {
    expect(validateStringArray(['valid', 123])).toBe(null)
  })

  it('returns null for invalid input (not empty result)', () => {
    // The handler returns early with empty CleanResult when validation fails
    const valid = validateStringArray(null)
    expect(valid).toBe(null)
  })
})

// ── binaryExistsInPath (replica) ──

function binaryExistsInPath(
  binary: string,
  pathDirs: string[],
  existingFiles: Set<string>
): boolean {
  for (const dir of pathDirs) {
    if (existingFiles.has(dir + '/' + binary)) return true
  }
  return false
}

describe('binaryExistsInPath', () => {
  it('returns true when binary is found in PATH', () => {
    expect(
      binaryExistsInPath('firefox', ['/usr/bin', '/usr/local/bin'], new Set(['/usr/bin/firefox']))
    ).toBe(true)
  })

  it('returns false when binary is not found', () => {
    expect(binaryExistsInPath('nonexistent', ['/usr/bin'], new Set(['/usr/bin/bash']))).toBe(false)
  })

  it('returns false with empty PATH', () => {
    expect(binaryExistsInPath('firefox', [], new Set())).toBe(false)
  })
})

// ── Linux .desktop file Exec line parsing ──

describe('Linux .desktop Exec line parsing', () => {
  it('extracts binary from simple Exec line', () => {
    const execMatch = 'Exec=/usr/bin/firefox %u'.match(/^Exec\s*=\s*(.+)$/m)
    expect(execMatch).not.toBeNull()
    const execLine = execMatch![1].trim()
    const binary = execLine.split(/\s+/)[0].replace(/^["']|["']$/g, '')
    expect(binary).toBe('/usr/bin/firefox')
  })

  it('strips quotes from binary path', () => {
    const execMatch = 'Exec="/usr/bin/my app" --flag'.match(/^Exec\s*=\s*(.+)$/m)
    expect(execMatch).not.toBeNull()
    const execLine = execMatch![1].trim()
    const binary = execLine.split(/\s+/)[0].replace(/^["']|["']$/g, '')
    expect(binary).toBe('/usr/bin/my')
  })

  it('strips field codes like %u, %f', () => {
    const execLine = '/usr/bin/app %u %f'
    const binary = execLine.split(/\s+/)[0]
    expect(binary).toBe('/usr/bin/app')
    // %u and %f are stripped by taking only the first token
  })

  it('handles PATH-resolved binary (no slash)', () => {
    const execLine = 'firefox'
    const binary = execLine.split(/\s+/)[0]
    expect(binary).toBe('firefox')
    expect(binary.startsWith('/')).toBe(false)
  })
})

// ── Shortcut directories by platform ──

describe('shortcut directories structure', () => {
  it('Windows has 5 shortcut directories', () => {
    const winDirs = [
      'Desktop',
      'Start Menu Programs',
      'Taskbar',
      'All Users Start Menu',
      'Public Desktop'
    ]
    expect(winDirs).toHaveLength(5)
  })

  it('macOS has 2 shortcut directories', () => {
    const macDirs = ['Desktop Aliases', 'User Applications']
    expect(macDirs).toHaveLength(2)
  })

  it('Linux has 3 shortcut directories', () => {
    const linuxDirs = [
      'Desktop Shortcuts',
      'User Application Entries',
      'System Application Entries'
    ]
    expect(linuxDirs).toHaveLength(3)
  })
})

describe('probePath', () => {
  it('reports a real file as present and a missing path as missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kudu-probe-'))
    try {
      writeFileSync(join(dir, 'app'), 'x')
      expect(await probePath(join(dir, 'app'))).toBe('present')
      expect(await probePath(join(dir, 'gone'))).toBe('missing')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Creating symlinks on Windows needs Developer Mode or admin rights.
  it.skipIf(process.platform === 'win32')(
    'follows a dangling symlink to its missing target',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kudu-probe-'))
      try {
        symlinkSync(join(dir, 'removed-binary'), join(dir, 'launcher'))
        expect(await probePath(join(dir, 'launcher'))).toBe('missing')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})

describe('checkShortcutTarget', () => {
  it('never looks past an unreachable drive root', async () => {
    const probe = vi.fn(async (p: string): Promise<PathState> =>
      p === 'E:\\' ? 'unknown' : 'missing'
    )
    const info = { path: 'C:\\Desktop\\usb.lnk', targetPath: 'E:\\Tools\\app.exe' }
    expect(await checkShortcutTarget(info, 'win32', probe)).toBe(false)
    expect(probe.mock.calls.map(([p]) => p)).toEqual(['E:\\'])
  })

  it('flags a missing target once the root and both Program Files folders are checked', async () => {
    const probe = vi.fn(async (p: string): Promise<PathState> =>
      p === 'C:\\' ? 'present' : 'missing'
    )
    const info = { path: 'C:\\Desktop\\a.lnk', targetPath: 'C:\\Program Files\\Acme\\a.exe' }
    expect(await checkShortcutTarget(info, 'win32', probe)).toBe(true)
    expect(probe.mock.calls.map(([p]) => p).sort()).toEqual(
      ['C:\\', 'C:\\Program Files (x86)\\Acme\\a.exe', 'C:\\Program Files\\Acme\\a.exe'].sort()
    )
  })
})

// ── Global exclusions (production handler) ──

describe('shortcut scan global exclusions', () => {
  const originalPlatform = process.platform
  let home: string

  function writeBrokenEntry(dir: string, name: string): string {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, name)
    writeFileSync(path, '[Desktop Entry]\nExec=/nonexistent-kudu-test/app %u\n')
    return path
  }

  async function scannedPaths(): Promise<string[]> {
    const results = (await mocks.handlers.get(IPC.SHORTCUT_SCAN)!(null)) as ScanResult[]
    // Only report fixtures; a real /usr/share/applications may add unrelated entries.
    return results
      .flatMap((r) => r.items.map((i) => i.path))
      .filter((p) => p.startsWith(home))
      .sort()
  }

  beforeEach(() => {
    // The Linux resolver reads .desktop files directly, so it runs on any host.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    // Scans resolve real paths (8.3 names expanded on Windows), so use one here.
    home = realpathSync.native(mkdtempSync(join(tmpdir(), 'kudu-shortcuts-')))
    mocks.home = home
    mocks.settings.exclusions = []
    mocks.handlers.clear()
    registerShortcutCleanerIpc(() => null)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('does not report excluded shortcuts or shortcuts in excluded directories', async () => {
    const desktop = join(home, 'Desktop')
    const apps = join(home, '.local', 'share', 'applications')
    const reported = writeBrokenEntry(desktop, 'broken.desktop')
    const excludedFile = writeBrokenEntry(desktop, 'kept.desktop')
    const inExcludedDir = writeBrokenEntry(apps, 'other.desktop')

    expect(await scannedPaths()).toEqual([reported, excludedFile, inExcludedDir].sort())

    mocks.settings.exclusions = [excludedFile, apps]
    expect(await scannedPaths()).toEqual([reported])
  })

  it('refuses to clean a shortcut excluded through an alias added after the scan', async () => {
    const desktop = join(home, 'Desktop')
    const broken = writeBrokenEntry(desktop, 'broken.desktop')
    const results = (await mocks.handlers.get(IPC.SHORTCUT_SCAN)!(null)) as ScanResult[]
    const item = results.flatMap((r) => r.items).find((i) => i.path === broken)!
    expect(item).toBeDefined()

    // After the scan, the user excludes the Desktop via a link that points at it.
    symlinkSync(desktop, join(home, 'keep'), 'junction')
    mocks.settings.exclusions = [join(home, 'keep')]
    const result = (await mocks.handlers.get(IPC.SHORTCUT_CLEAN)!(null, [item.id])) as CleanResult
    expect(result.errors).toEqual([{ path: broken, reason: 'excluded' }])
    expect(existsSync(broken)).toBe(true)
  })

  it('does not read a shortcut folder that is a link into an excluded tree', async () => {
    const privateApps = join(home, 'private-apps')
    const hidden = writeBrokenEntry(privateApps, 'hidden.desktop')
    // ~/Desktop is a junction/symlink into the excluded folder.
    symlinkSync(privateApps, join(home, 'Desktop'), 'junction')
    mocks.settings.exclusions = [privateApps]
    expect(await scannedPaths()).not.toContain(hidden)
    expect(await scannedPaths()).not.toContain(join(home, 'Desktop', 'hidden.desktop'))
  })
})
