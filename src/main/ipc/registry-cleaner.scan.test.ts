import { describe, it, expect, vi, beforeEach } from 'vitest'
import { promisify } from 'util'

const { mockRecordRecoveryChange, mockReadRecoveryTarget } = vi.hoisted(() => ({
  mockRecordRecoveryChange: vi.fn(
    async (
      _source: unknown,
      _label: unknown,
      _target: unknown,
      _before: unknown,
      _after: unknown,
      apply: () => Promise<void>
    ) => apply()
  ),
  mockReadRecoveryTarget: vi.fn(async (target: { kind: string }) =>
    target.kind === 'service-start'
      ? { start: 3, delayed: null, running: false }
      : target.kind === 'task-enabled'
        ? false
        : 0
  )
}))
vi.mock('../services/recovery-store', () => ({
  recordRecoveryChange: (...args: Parameters<typeof mockRecordRecoveryChange>) =>
    mockRecordRecoveryChange(...args)
}))
vi.mock('../services/recovery', () => ({
  readRecoveryTarget: (target: { kind: string }) => mockReadRecoveryTarget(target)
}))

// ── Mocks ───────────────────────────────────────────────────────────
// These tests drive the real scan/fix code against realistic reg.exe
// output. The pure-helper tests in registry-cleaner.ipc.test.ts use
// replicas, which cannot catch a mismatch between a scan's regex and
// what reg.exe actually prints — the defect this file guards against.

const mockExecNative = vi.fn()

function createExecFileMock() {
  const fn = (...args: unknown[]) => (args[args.length - 1] as any)?.(null, '', '')
  ;(fn as any)[promisify.custom] = () => Promise.resolve({ stdout: '', stderr: '' })
  return fn
}

vi.mock('child_process', () => ({ execFile: createExecFileMock() }))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

vi.mock('../services/exec-utf8', () => ({
  execNativeUtf8: (tool: string, args: string[], opts?: any) => mockExecNative(tool, args, opts),
  execTracked: vi.fn(async () => ({ stdout: '', stderr: '' })),
  psUtf8: (cmd: string) => cmd
}))

const mockExistsSync = vi.fn((_p: string): boolean => true)
const mockReaddirSync = vi.fn((_p: string): string[] => [])
const mockWriteFileSync = vi.fn()
const mockUnlinkSync = vi.fn()

vi.mock('fs', () => ({
  existsSync: (p: string) => mockExistsSync(p),
  statSync: () => ({ isFile: () => true }),
  readdirSync: (p: string) => mockReaddirSync(p),
  unlinkSync: (p: string) => mockUnlinkSync(p),
  mkdirSync: vi.fn(),
  mkdtempSync: () => 'C:\\temp\\kudu-test',
  readFileSync: () => '',
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  rmSync: vi.fn()
}))

const mockSeal = {
  createPrivateTempDir: vi.fn(),
  sealBackup: vi.fn(),
  removeSeals: vi.fn()
}
vi.mock('../services/registry-backup-seal', () => ({
  createPrivateTempDir: (prefix: string) => mockSeal.createPrivateTempDir(prefix),
  sealBackup: (dir: string, name: string, bytes: Buffer) => mockSeal.sealBackup(dir, name, bytes),
  removeSeals: (dir: string, names: string[]) => mockSeal.removeSeals(dir, names)
}))

vi.mock('../services/backup-dir', () => ({ getBackupDir: () => 'C:\\temp\\backups' }))

vi.mock('../services/settings-store', () => ({
  getSettings: () => ({}),
  updateRegistryIgnoredTweaks: vi.fn()
}))

vi.mock('../services/ipc-validation', () => ({ validateStringArray: (a: string[]) => a }))

import {
  scanRegistry,
  fixRegistryEntries,
  normalizeHiveNames,
  isProtectedDeleteKey
} from './registry-cleaner.ipc'

const APP_PATHS_ROOT = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths'

/** Verbatim `reg query "HKLM\...\App Paths" /s` output — note the long hive names. */
const APP_PATHS_OUTPUT = [
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
  '    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '    Path    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\ghost.exe',
  '    (Default)    REG_SZ    C:\\Program Files\\Uninstalled\\ghost.exe',
  ''
].join('\r\n')

beforeEach(() => {
  vi.clearAllMocks()
  mockExistsSync.mockImplementation(() => true)
  mockReaddirSync.mockImplementation(() => [])
  mockExecNative.mockImplementation(async () => ({ stdout: '', stderr: '' }))
  mockSeal.createPrivateTempDir.mockResolvedValue('C:\\Windows\\Temp\\kudu-reg-backup-private')
  mockSeal.sealBackup.mockResolvedValue(true)
  mockSeal.removeSeals.mockResolvedValue(undefined)
})

describe('normalizeHiveNames', () => {
  it('rewrites long-form hive names in key headers to short form', () => {
    expect(normalizeHiveNames('HKEY_LOCAL_MACHINE\\SOFTWARE\\Foo')).toBe('HKLM\\SOFTWARE\\Foo')
    expect(normalizeHiveNames('HKEY_CURRENT_USER\\SOFTWARE\\Foo')).toBe('HKCU\\SOFTWARE\\Foo')
    expect(normalizeHiveNames('HKEY_CLASSES_ROOT\\CLSID\\{abc}')).toBe('HKCR\\CLSID\\{abc}')
  })

  it('leaves indented value lines untouched', () => {
    const input =
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Foo\r\n    Data    REG_SZ    HKEY_LOCAL_MACHINE\\Bar\r\n'
    expect(normalizeHiveNames(input)).toBe(
      'HKLM\\SOFTWARE\\Foo\r\n    Data    REG_SZ    HKEY_LOCAL_MACHINE\\Bar\r\n'
    )
  })

  it('leaves already-short and unknown hives alone', () => {
    expect(normalizeHiveNames('HKLM\\SOFTWARE\\Foo')).toBe('HKLM\\SOFTWARE\\Foo')
    expect(normalizeHiveNames('HKEY_MADE_UP\\Foo')).toBe('HKEY_MADE_UP\\Foo')
  })
})

describe('scanRegistry — App Paths', () => {
  function stubAppPaths(): void {
    mockExecNative.mockImplementation(async (tool: string, args: string[]) => {
      if (tool === 'reg' && args[0] === 'query' && args[1] === APP_PATHS_ROOT) {
        return { stdout: APP_PATHS_OUTPUT, stderr: '' }
      }
      if (tool === 'schtasks') throw new Error('no tasks')
      return { stdout: '', stderr: '' }
    })
    mockExistsSync.mockImplementation((p: string) => !String(p).includes('Uninstalled'))
  }

  it('targets the stale subkey, never the App Paths container', async () => {
    stubAppPaths()
    const entries = await scanRegistry()
    const appPathFindings = entries.filter((e) =>
      e.issue.startsWith('App path points to missing file')
    )

    expect(appPathFindings).toHaveLength(1)
    expect(appPathFindings[0].keyPath).toBe(`${APP_PATHS_ROOT}\\ghost.exe`)
    // The regression: a failed header parse used to fall back to the container,
    // so applying the fix deleted every App Paths registration on the machine.
    expect(appPathFindings[0].keyPath).not.toBe(APP_PATHS_ROOT)
  })

  it('does not flag app paths whose executable still exists', async () => {
    stubAppPaths()
    const entries = await scanRegistry()
    expect(entries.some((e) => e.issue.includes('chrome.exe'))).toBe(false)
  })

  it('emits nothing for App Paths when the key header cannot be parsed', async () => {
    mockExecNative.mockImplementation(async (tool: string, args: string[]) => {
      if (tool === 'reg' && args[0] === 'query' && args[1] === APP_PATHS_ROOT) {
        // Header line missing entirely — the scan must not guess a key.
        return { stdout: '    (Default)    REG_SZ    C:\\Gone\\gone.exe\r\n', stderr: '' }
      }
      if (tool === 'schtasks') throw new Error('no tasks')
      return { stdout: '', stderr: '' }
    })
    mockExistsSync.mockImplementation(() => false)

    const entries = await scanRegistry()
    expect(entries.some((e) => e.issue.startsWith('App path points to missing file'))).toBe(false)
  })
})

describe('previously-dead scans ship unticked', () => {
  const TYPELIB_OUTPUT = [
    'HKEY_CLASSES_ROOT\\TypeLib\\{11111111-2222-3333-4444-555555555555}\\1.0\\0\\win32',
    '    (Default)    REG_SZ    C:\\Program Files\\Gone\\gone.tlb',
    ''
  ].join('\r\n')

  it('reports a revived finding but leaves it deselected', async () => {
    mockExecNative.mockImplementation(async (tool: string, args: string[]) => {
      if (tool === 'reg' && args[0] === 'query' && args[1] === 'HKCR\\TypeLib') {
        return { stdout: TYPELIB_OUTPUT, stderr: '' }
      }
      if (tool === 'schtasks') throw new Error('no tasks')
      return { stdout: '', stderr: '' }
    })
    mockExistsSync.mockImplementation((p: string) => !String(p).includes('Gone'))

    const entries = await scanRegistry()
    const tlb = entries.filter((e) => e.issue.startsWith('Type library file missing'))

    expect(tlb).toHaveLength(1)
    // These scans never executed before hive normalization landed, so a finding
    // must not arrive pre-ticked for deletion.
    expect(tlb[0].selected).toBe(false)
    expect(tlb[0].keyPath).toContain('{11111111-2222-3333-4444-555555555555}')
  })
})

describe('scanRegistry — TypeLib', () => {
  // {00000300-…} carries both 2.8 and 6.0 on a stock Windows install.
  const MULTI_VERSION_OUTPUT = [
    'HKEY_CLASSES_ROOT\\TypeLib\\{00000300-0000-0010-8000-00AA006D2EA4}\\2.8\\0\\win32',
    '    (Default)    REG_SZ    C:\\Program Files\\Gone\\old.tlb',
    '',
    'HKEY_CLASSES_ROOT\\TypeLib\\{00000300-0000-0010-8000-00AA006D2EA4}\\6.0\\0\\win32',
    '    (Default)    REG_SZ    C:\\Windows\\System32\\current.tlb',
    ''
  ].join('\r\n')

  it('deletes only the stale version key, never the GUID parent', async () => {
    mockExecNative.mockImplementation(async (tool: string, args: string[]) => {
      if (tool === 'reg' && args[0] === 'query' && args[1] === 'HKCR\\TypeLib') {
        return { stdout: MULTI_VERSION_OUTPUT, stderr: '' }
      }
      if (tool === 'schtasks') throw new Error('no tasks')
      return { stdout: '', stderr: '' }
    })
    mockExistsSync.mockImplementation((p: string) => !String(p).includes('Gone'))

    const entries = await scanRegistry()
    const tlb = entries.filter((e) => e.issue.startsWith('Type library file missing'))

    expect(tlb).toHaveLength(1)
    const target = tlb[0].fix?.key ?? tlb[0].keyPath
    // Deleting the GUID parent would take the healthy 6.0 registration with it.
    expect(target).toBe('HKCR\\TypeLib\\{00000300-0000-0010-8000-00AA006D2EA4}\\2.8\\0\\win32')
    expect(target).not.toBe('HKCR\\TypeLib\\{00000300-0000-0010-8000-00AA006D2EA4}')
  })

  it('ignores a GUID node with no version segment below it', async () => {
    mockExecNative.mockImplementation(async (tool: string, args: string[]) => {
      if (tool === 'reg' && args[0] === 'query' && args[1] === 'HKCR\\TypeLib') {
        return {
          stdout:
            'HKEY_CLASSES_ROOT\\TypeLib\\{00000300-0000-0010-8000-00AA006D2EA4}\r\n    (Default)    REG_SZ    C:\\Gone\\x.tlb\r\n',
          stderr: ''
        }
      }
      if (tool === 'schtasks') throw new Error('no tasks')
      return { stdout: '', stderr: '' }
    })
    mockExistsSync.mockImplementation(() => false)

    const entries = await scanRegistry()
    expect(entries.some((e) => e.issue.startsWith('Type library file missing'))).toBe(false)
  })
})

describe('scanRegistry — OpenWithList', () => {
  // Verbatim layout: the app is the value *data*, under an ordinal value *name*.
  const OPEN_WITH_OUTPUT = [
    'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.txt\\OpenWithList',
    '    a    REG_SZ    notepad.exe',
    '    b    REG_SZ    ghost.exe',
    '    MRUList    REG_SZ    ab',
    ''
  ].join('\r\n')

  function stubOpenWith(): void {
    mockExecNative.mockImplementation(async (tool: string, args: string[]) => {
      if (tool === 'reg' && args[0] === 'query' && String(args[1]).endsWith('FileExts')) {
        return { stdout: OPEN_WITH_OUTPUT, stderr: '' }
      }
      // notepad.exe is a registered App Path; ghost.exe is not.
      if (
        tool === 'reg' &&
        args[0] === 'query' &&
        String(args[1]).includes('App Paths\\notepad.exe')
      ) {
        return { stdout: 'ok', stderr: '' }
      }
      if (tool === 'reg' && args[0] === 'query' && String(args[1]).includes('App Paths\\')) {
        throw new Error('not found')
      }
      if (tool === 'schtasks') throw new Error('no tasks')
      return { stdout: '', stderr: '' }
    })
  }

  it('reports the ordinal value name, not the executable data', async () => {
    stubOpenWith()
    const entries = await scanRegistry()
    const found = entries.filter((e) =>
      e.issue.startsWith('File association references unregistered app')
    )

    expect(found).toHaveLength(1)
    // `reg delete /v ghost.exe` would always fail — the value is named "b".
    expect(found[0].valueName).toBe('b')
    expect(found[0].issue).toContain('ghost.exe')
  })

  it('leaves registered apps and the MRUList index alone', async () => {
    stubOpenWith()
    const entries = await scanRegistry()
    const found = entries.filter((e) =>
      e.issue.startsWith('File association references unregistered app')
    )

    expect(found.some((e) => e.valueName === 'a')).toBe(false)
    expect(found.some((e) => e.valueName.toLowerCase() === 'mrulist')).toBe(false)
  })
})

describe('isProtectedDeleteKey', () => {
  it('blocks bare hive roots in both forms', () => {
    for (const k of ['HKLM', 'HKCU', 'HKCR', 'HKEY_LOCAL_MACHINE', 'HKEY_CLASSES_ROOT']) {
      expect(isProtectedDeleteKey(k)).toBe(true)
    }
  })

  it('blocks the container keys the scans enumerate', () => {
    for (const k of [
      APP_PATHS_ROOT,
      'HKLM\\SYSTEM\\CurrentControlSet\\Services',
      'HKCR\\CLSID',
      'HKCR\\Interface',
      'HKCR\\TypeLib',
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKCR\\*\\shellex\\ContextMenuHandlers'
    ]) {
      expect(isProtectedDeleteKey(k)).toBe(true)
    }
  })

  it('matches regardless of hive form, casing, or trailing slash', () => {
    expect(isProtectedDeleteKey('HKEY_CLASSES_ROOT\\CLSID')).toBe(true)
    expect(isProtectedDeleteKey('hkcr\\clsid')).toBe(true)
    expect(isProtectedDeleteKey('HKCR\\CLSID\\')).toBe(true)
  })

  it('allows genuine leaf keys', () => {
    expect(isProtectedDeleteKey(`${APP_PATHS_ROOT}\\ghost.exe`)).toBe(false)
    expect(isProtectedDeleteKey('HKCR\\CLSID\\{abc-def}')).toBe(false)
    expect(isProtectedDeleteKey('HKLM\\SYSTEM\\CurrentControlSet\\Services\\SomeApp')).toBe(false)
  })
})

describe('fixRegistryEntries — protected key guard', () => {
  const entry = (keyPath: string) => ({
    id: 'e1',
    type: 'invalid' as const,
    keyPath,
    valueName: '(Default)',
    issue: 'test',
    risk: 'low' as const,
    selected: true,
    fix: { op: 'delete-key' as const }
  })

  it('refuses to delete a container key and reports it as a failure', async () => {
    const result = await fixRegistryEntries([entry(APP_PATHS_ROOT)] as any)

    expect(result.fixed).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.failures[0].reason).toContain('protected registry key')

    const deletes = mockExecNative.mock.calls.filter((c) => c[0] === 'reg' && c[1][0] === 'delete')
    expect(deletes).toHaveLength(0)
  })

  it('still deletes a genuine leaf key', async () => {
    const target = `${APP_PATHS_ROOT}\\ghost.exe`
    const result = await fixRegistryEntries([entry(target)] as any)

    expect(result.fixed).toBe(1)
    const deletes = mockExecNative.mock.calls.filter((c) => c[0] === 'reg' && c[1][0] === 'delete')
    expect(deletes).toHaveLength(1)
    expect(deletes[0][1]).toEqual(['delete', target, '/f'])
  })
})

describe('fixRegistryEntries — delete-value recovery journaling', () => {
  const DEFENDER_KEY = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender'
  const entry = (fix: Record<string, unknown>, valueName = 'DisableAntiSpyware') => ({
    id: 'e1',
    type: 'vulnerability' as const,
    keyPath: DEFENDER_KEY,
    valueName,
    issue: 'Windows Defender antivirus is completely disabled via policy',
    risk: 'high' as const,
    selected: true,
    fix
  })
  const regDeletes = () =>
    mockExecNative.mock.calls.filter((c) => c[0] === 'reg' && c[1][0] === 'delete')

  it('scan preserves the detected REG_DWORD type on Defender policy deletes', async () => {
    mockExecNative.mockImplementation(async (_tool: string, args: string[]) => {
      if (args[0] === 'query' && args[3] === 'DisableAntiSpyware')
        return {
          stdout: `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\r\n    DisableAntiSpyware    REG_DWORD    0x1\r\n\r\n`,
          stderr: ''
        }
      if (args[0] === 'query' && args[3] === 'DisableRealtimeMonitoring')
        return {
          stdout: `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection\r\n    DisableRealtimeMonitoring    REG_DWORD    0x1\r\n\r\n`,
          stderr: ''
        }
      return { stdout: '', stderr: '' }
    })

    const entries = await scanRegistry()
    const byName = (n: string) => entries.find((e) => e.valueName === n)
    expect(byName('DisableAntiSpyware')?.fix).toEqual({
      op: 'delete-value',
      regType: 'REG_DWORD'
    })
    expect(byName('DisableRealtimeMonitoring')?.fix).toEqual({
      op: 'delete-value',
      regType: 'REG_DWORD'
    })
  })

  it('journals a DWORD delete with the current value and a null after-state, then deletes', async () => {
    mockReadRecoveryTarget.mockResolvedValueOnce(1)

    const result = await fixRegistryEntries([
      entry({ op: 'delete-value', regType: 'REG_DWORD' })
    ] as any)

    expect(result.fixed).toBe(1)
    expect(mockReadRecoveryTarget).toHaveBeenCalledWith({
      kind: 'registry-dword',
      key: DEFENDER_KEY,
      name: 'DisableAntiSpyware'
    })
    expect(mockRecordRecoveryChange).toHaveBeenCalledTimes(1)
    const [source, label, target, before, after] = mockRecordRecoveryChange.mock.calls[0]
    expect(source).toBe('registry')
    expect(label).toBe('Windows Defender antivirus is completely disabled via policy')
    expect(target).toEqual({
      kind: 'registry-dword',
      key: DEFENDER_KEY,
      name: 'DisableAntiSpyware'
    })
    expect(before).toBe(1)
    expect(after).toBeNull()

    const deletes = regDeletes()
    expect(deletes).toHaveLength(1)
    expect(deletes[0][1]).toEqual(['delete', DEFENDER_KEY, '/v', 'DisableAntiSpyware', '/f'])
  })

  it('does not journal a DWORD delete when the value is already gone', async () => {
    mockReadRecoveryTarget.mockResolvedValueOnce(null)

    await fixRegistryEntries([entry({ op: 'delete-value', regType: 'REG_DWORD' })] as any)

    expect(mockRecordRecoveryChange).not.toHaveBeenCalled()
    expect(regDeletes()).toHaveLength(1)
  })

  it('does not journal a non-DWORD delete', async () => {
    const result = await fixRegistryEntries([
      entry({ op: 'delete-value' }, 'StaleEntry'),
      entry({ op: 'delete-value', regType: 'REG_SZ' }, 'StalePath')
    ] as any)

    expect(result.fixed).toBe(2)
    expect(mockReadRecoveryTarget).not.toHaveBeenCalled()
    expect(mockRecordRecoveryChange).not.toHaveBeenCalled()
    expect(regDeletes()).toHaveLength(2)
  })
})

describe('fixRegistryEntries — targeted backup seals', () => {
  const KEY = 'HKCU\\SOFTWARE\\Stale\\App'
  const entry = {
    id: 'e1',
    type: 'invalid' as const,
    keyPath: KEY,
    valueName: 'Path',
    issue: 'stale',
    risk: 'low' as const,
    selected: true,
    fix: { op: 'delete-value' as const }
  }
  const targetedWrites = () =>
    mockWriteFileSync.mock.calls.filter((c) =>
      /registry-backup-targeted-.*\.reg$/.test(String(c[0]))
    )

  it('exports into a private folder and seals exactly the bytes it wrote', async () => {
    await fixRegistryEntries([entry] as any)

    expect(mockSeal.createPrivateTempDir).toHaveBeenCalledWith('kudu-reg-backup-')
    const exp = mockExecNative.mock.calls.find((c) => c[0] === 'reg' && c[1][0] === 'export')!
    // Joined with the host's path module, so either separator follows the folder.
    expect(exp[1][2]).toMatch(/^C:\\Windows\\Temp\\kudu-reg-backup-private[\\/]/)
    const [write] = targetedWrites()
    const fileName = String(write[0]).split(/[\\/]/).pop()
    expect(mockSeal.sealBackup).toHaveBeenCalledWith('C:\\temp\\backups', fileName, write[1])
    expect(Buffer.isBuffer(write[1])).toBe(true)
  })

  it('still writes the backup, unsealed, when no private folder can be made', async () => {
    mockSeal.createPrivateTempDir.mockRejectedValue(new Error('not elevated'))

    const result = await fixRegistryEntries([entry] as any)

    expect(targetedWrites()).toHaveLength(1)
    expect(mockSeal.sealBackup).not.toHaveBeenCalled()
    expect(result.fixed).toBe(1)
  })

  it('backs up HKCR keys as their HKLM and HKCU Classes keys, never through HKCR', async () => {
    await fixRegistryEntries([
      { ...entry, keyPath: 'HKCR\\CLSID\\{abc}', fix: { op: 'delete-key' as const } },
      { ...entry, id: 'e2', keyPath: 'HKEY_CLASSES_ROOT\\.foo', fix: { op: 'delete-key' as const } }
    ] as any)

    const exported = mockExecNative.mock.calls
      .filter((c) => c[0] === 'reg' && c[1][0] === 'export')
      .map((c) => c[1][1])
    expect(exported).toEqual([
      'HKLM\\SOFTWARE\\Classes\\CLSID\\{abc}',
      'HKCU\\SOFTWARE\\Classes\\CLSID\\{abc}',
      'HKLM\\SOFTWARE\\Classes\\.foo',
      'HKCU\\SOFTWARE\\Classes\\.foo'
    ])
  })

  it('carries on with the fix when sealing fails', async () => {
    mockSeal.sealBackup.mockResolvedValue(false)
    const result = await fixRegistryEntries([entry] as any)
    expect(targetedWrites()).toHaveLength(1)
    expect(result.fixed).toBe(1)
  })

  it('drops the seals of targeted backups it prunes', async () => {
    const stamp = (d: number) => `2026-01-0${d}T00-00-00-000Z`
    mockReaddirSync.mockImplementation(() => [
      `registry-backup-targeted-${stamp(1)}.reg`,
      `registry-backup-tasks-${stamp(1)}`,
      `registry-backup-${stamp(2)}.reg`,
      `registry-backup-targeted-${stamp(3)}.reg`,
      `registry-backup-targeted-${stamp(4)}.reg`,
      `registry-backup-targeted-${stamp(5)}.reg`
    ])

    await fixRegistryEntries([entry] as any)

    // Only the three newest runs are kept; the two oldest are removed with their seals.
    expect(mockUnlinkSync.mock.calls.map((c) => String(c[0]).split(/[\\/]/).pop()).sort()).toEqual([
      `registry-backup-${stamp(2)}.reg`,
      `registry-backup-targeted-${stamp(1)}.reg`
    ])
    // Every removed file's seal is dropped (removeSeals skips names never sealed).
    expect(mockSeal.removeSeals).toHaveBeenCalledTimes(1)
    expect([...mockSeal.removeSeals.mock.calls[0][1]].sort()).toEqual([
      `registry-backup-${stamp(2)}.reg`,
      `registry-backup-targeted-${stamp(1)}.reg`
    ])
  })
})
