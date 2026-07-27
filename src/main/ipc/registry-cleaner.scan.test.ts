import { describe, it, expect, vi, beforeEach } from 'vitest'
import { promisify } from 'util'

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
  psUtf8: (cmd: string) => cmd,
}))

const mockExistsSync = vi.fn((_p: string): boolean => true)

vi.mock('fs', () => ({
  existsSync: (p: string) => mockExistsSync(p),
  statSync: () => ({ isFile: () => true }),
  readdirSync: () => [],
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  mkdtempSync: () => 'C:\\temp\\kudu-test',
  readFileSync: () => '',
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}))

vi.mock('../services/backup-dir', () => ({ getBackupDir: () => 'C:\\temp\\backups' }))

vi.mock('../services/settings-store', () => ({
  getSettings: () => ({}),
  updateRegistryIgnoredTweaks: vi.fn(),
}))

vi.mock('../services/ipc-validation', () => ({ validateStringArray: (a: string[]) => a }))

import {
  scanRegistry,
  fixRegistryEntries,
  normalizeHiveNames,
  isProtectedDeleteKey,
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
  '',
].join('\r\n')

beforeEach(() => {
  vi.clearAllMocks()
  mockExistsSync.mockImplementation(() => true)
  mockExecNative.mockImplementation(async () => ({ stdout: '', stderr: '' }))
})

describe('normalizeHiveNames', () => {
  it('rewrites long-form hive names in key headers to short form', () => {
    expect(normalizeHiveNames('HKEY_LOCAL_MACHINE\\SOFTWARE\\Foo')).toBe('HKLM\\SOFTWARE\\Foo')
    expect(normalizeHiveNames('HKEY_CURRENT_USER\\SOFTWARE\\Foo')).toBe('HKCU\\SOFTWARE\\Foo')
    expect(normalizeHiveNames('HKEY_CLASSES_ROOT\\CLSID\\{abc}')).toBe('HKCR\\CLSID\\{abc}')
  })

  it('leaves indented value lines untouched', () => {
    const input = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Foo\r\n    Data    REG_SZ    HKEY_LOCAL_MACHINE\\Bar\r\n'
    expect(normalizeHiveNames(input)).toBe('HKLM\\SOFTWARE\\Foo\r\n    Data    REG_SZ    HKEY_LOCAL_MACHINE\\Bar\r\n')
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
    const appPathFindings = entries.filter(e => e.issue.startsWith('App path points to missing file'))

    expect(appPathFindings).toHaveLength(1)
    expect(appPathFindings[0].keyPath).toBe(`${APP_PATHS_ROOT}\\ghost.exe`)
    // The regression: a failed header parse used to fall back to the container,
    // so applying the fix deleted every App Paths registration on the machine.
    expect(appPathFindings[0].keyPath).not.toBe(APP_PATHS_ROOT)
  })

  it('does not flag app paths whose executable still exists', async () => {
    stubAppPaths()
    const entries = await scanRegistry()
    expect(entries.some(e => e.issue.includes('chrome.exe'))).toBe(false)
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
    expect(entries.some(e => e.issue.startsWith('App path points to missing file'))).toBe(false)
  })
})

describe('previously-dead scans ship unticked', () => {
  const TYPELIB_OUTPUT = [
    'HKEY_CLASSES_ROOT\\TypeLib\\{11111111-2222-3333-4444-555555555555}\\1.0\\0\\win32',
    '    (Default)    REG_SZ    C:\\Program Files\\Gone\\gone.tlb',
    '',
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
    const tlb = entries.filter(e => e.issue.startsWith('Type library file missing'))

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
    '',
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
    const tlb = entries.filter(e => e.issue.startsWith('Type library file missing'))

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
          stdout: 'HKEY_CLASSES_ROOT\\TypeLib\\{00000300-0000-0010-8000-00AA006D2EA4}\r\n    (Default)    REG_SZ    C:\\Gone\\x.tlb\r\n',
          stderr: '',
        }
      }
      if (tool === 'schtasks') throw new Error('no tasks')
      return { stdout: '', stderr: '' }
    })
    mockExistsSync.mockImplementation(() => false)

    const entries = await scanRegistry()
    expect(entries.some(e => e.issue.startsWith('Type library file missing'))).toBe(false)
  })
})

describe('scanRegistry — OpenWithList', () => {
  // Verbatim layout: the app is the value *data*, under an ordinal value *name*.
  const OPEN_WITH_OUTPUT = [
    'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.txt\\OpenWithList',
    '    a    REG_SZ    notepad.exe',
    '    b    REG_SZ    ghost.exe',
    '    MRUList    REG_SZ    ab',
    '',
  ].join('\r\n')

  function stubOpenWith(): void {
    mockExecNative.mockImplementation(async (tool: string, args: string[]) => {
      if (tool === 'reg' && args[0] === 'query' && String(args[1]).endsWith('FileExts')) {
        return { stdout: OPEN_WITH_OUTPUT, stderr: '' }
      }
      // notepad.exe is a registered App Path; ghost.exe is not.
      if (tool === 'reg' && args[0] === 'query' && String(args[1]).includes('App Paths\\notepad.exe')) {
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
    const found = entries.filter(e => e.issue.startsWith('File association references unregistered app'))

    expect(found).toHaveLength(1)
    // `reg delete /v ghost.exe` would always fail — the value is named "b".
    expect(found[0].valueName).toBe('b')
    expect(found[0].issue).toContain('ghost.exe')
  })

  it('leaves registered apps and the MRUList index alone', async () => {
    stubOpenWith()
    const entries = await scanRegistry()
    const found = entries.filter(e => e.issue.startsWith('File association references unregistered app'))

    expect(found.some(e => e.valueName === 'a')).toBe(false)
    expect(found.some(e => e.valueName.toLowerCase() === 'mrulist')).toBe(false)
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
      'HKCR\\*\\shellex\\ContextMenuHandlers',
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
    fix: { op: 'delete-key' as const },
  })

  it('refuses to delete a container key and reports it as a failure', async () => {
    const result = await fixRegistryEntries([entry(APP_PATHS_ROOT)] as any)

    expect(result.fixed).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.failures[0].reason).toContain('protected registry key')

    const deletes = mockExecNative.mock.calls.filter(c => c[0] === 'reg' && c[1][0] === 'delete')
    expect(deletes).toHaveLength(0)
  })

  it('still deletes a genuine leaf key', async () => {
    const target = `${APP_PATHS_ROOT}\\ghost.exe`
    const result = await fixRegistryEntries([entry(target)] as any)

    expect(result.fixed).toBe(1)
    const deletes = mockExecNative.mock.calls.filter(c => c[0] === 'reg' && c[1][0] === 'delete')
    expect(deletes).toHaveLength(1)
    expect(deletes[0][1]).toEqual(['delete', target, '/f'])
  })
})
