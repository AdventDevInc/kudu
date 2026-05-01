import { describe, it, expect, vi } from 'vitest'

// ── Mocks ──
// The IPC module imports electron and our exec-utf8 wrapper. We mock electron
// so the registration code in the module body doesn't crash on import; the
// pure helpers themselves don't touch electron at runtime.

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/kudu-test-userdata' },
  ipcMain: { handle: vi.fn() },
}))

vi.mock('../services/exec-utf8', () => ({
  execNativeUtf8: vi.fn(),
}))

vi.mock('../services/elevation', () => ({
  isAdmin: () => true,
}))

import {
  CLSID_SAFELIST,
  SCAN_ROOTS,
  VERB_SAFELIST,
  disabledNameFor,
  extractClsid,
  inferSource,
  isDisabledHandlerName,
  isProtectedClsid,
  isProtectedVerb,
  normalizeKeyPath,
  parentKeyOf,
  parseRegQueryBlocks,
} from './context-menu-cleaner.ipc'

// ── isProtectedVerb ──

describe('isProtectedVerb', () => {
  it('matches safelisted verbs case-insensitively', () => {
    expect(isProtectedVerb('open')).toBe(true)
    expect(isProtectedVerb('OPEN')).toBe(true)
    expect(isProtectedVerb('Open')).toBe(true)
    expect(isProtectedVerb('Print')).toBe(true)
    expect(isProtectedVerb('Properties')).toBe(true)
  })

  it('trims whitespace before matching', () => {
    expect(isProtectedVerb('  open  ')).toBe(true)
    expect(isProtectedVerb('\tedit\n')).toBe(true)
  })

  it('returns false for vendor verbs', () => {
    expect(isProtectedVerb('7-Zip')).toBe(false)
    expect(isProtectedVerb('Edit with Notepad++')).toBe(false)
    expect(isProtectedVerb('Open with Code')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isProtectedVerb('')).toBe(false)
  })
})

// ── isProtectedClsid ──

describe('isProtectedClsid', () => {
  it('matches safelisted CLSIDs regardless of case', () => {
    const onedrive = '{CB3D0F55-BC2C-4C1A-85ED-23ED75B5106B}'
    expect(isProtectedClsid(onedrive)).toBe(true)
    expect(isProtectedClsid(onedrive.toLowerCase())).toBe(true)
    expect(isProtectedClsid(onedrive.toUpperCase())).toBe(true)
  })

  it('matches safelisted CLSIDs without braces', () => {
    expect(isProtectedClsid('CB3D0F55-BC2C-4C1A-85ED-23ED75B5106B')).toBe(true)
  })

  it('returns false for random CLSIDs', () => {
    expect(isProtectedClsid('{12345678-1234-1234-1234-123456789ABC}')).toBe(false)
  })

  it('returns false for empty input', () => {
    expect(isProtectedClsid('')).toBe(false)
  })
})

// ── disabledNameFor & isDisabledHandlerName ──

describe('disabledNameFor', () => {
  it('prefixes handler names with a dash', () => {
    expect(disabledNameFor('handler', '7-Zip')).toBe('-7-Zip')
    expect(disabledNameFor('handler', 'OneDrive')).toBe('-OneDrive')
  })

  it('leaves verb names unchanged (verbs use LegacyDisable, not rename)', () => {
    expect(disabledNameFor('verb', 'Open with Code')).toBe('Open with Code')
    expect(disabledNameFor('verb', '7-Zip')).toBe('7-Zip')
  })
})

describe('isDisabledHandlerName', () => {
  it('detects leading dash', () => {
    expect(isDisabledHandlerName('-7-Zip')).toBe(true)
    expect(isDisabledHandlerName('-')).toBe(true)
  })

  it('returns false for un-prefixed names', () => {
    expect(isDisabledHandlerName('7-Zip')).toBe(false)
    expect(isDisabledHandlerName('')).toBe(false)
  })
})

// ── extractClsid ──

describe('extractClsid', () => {
  it('extracts a CLSID from a default-value string', () => {
    expect(extractClsid('{23170F69-40C1-2702-2401-000100020000}')).toBe('{23170F69-40C1-2702-2401-000100020000}')
  })

  it('extracts a CLSID embedded in surrounding text', () => {
    expect(extractClsid('foo {23170F69-40C1-2702-2401-000100020000} bar')).toBe('{23170F69-40C1-2702-2401-000100020000}')
  })

  it('returns null for non-CLSID strings', () => {
    expect(extractClsid('plain name')).toBeNull()
    expect(extractClsid('{too-short}')).toBeNull()
    expect(extractClsid(null)).toBeNull()
    expect(extractClsid('')).toBeNull()
  })
})

// ── normalizeKeyPath ──

describe('normalizeKeyPath', () => {
  it('rewrites HKEY_CLASSES_ROOT to HKCR', () => {
    expect(normalizeKeyPath('HKEY_CLASSES_ROOT\\*\\shell\\7-Zip'))
      .toBe('HKCR\\*\\shell\\7-Zip')
  })

  it('rewrites HKEY_CURRENT_USER to HKCU', () => {
    expect(normalizeKeyPath('HKEY_CURRENT_USER\\Software\\Classes'))
      .toBe('HKCU\\Software\\Classes')
  })

  it('leaves already-short paths alone', () => {
    expect(normalizeKeyPath('HKCR\\*\\shell')).toBe('HKCR\\*\\shell')
  })

  it('returns input unchanged when prefix is unknown', () => {
    expect(normalizeKeyPath('HKEY_USERS\\foo')).toBe('HKEY_USERS\\foo')
    expect(normalizeKeyPath('no-backslash')).toBe('no-backslash')
  })
})

// ── parentKeyOf ──

describe('parentKeyOf', () => {
  it('returns everything before the final backslash', () => {
    expect(parentKeyOf('HKCR\\*\\shellex\\ContextMenuHandlers\\7-Zip'))
      .toBe('HKCR\\*\\shellex\\ContextMenuHandlers')
  })

  it('returns input unchanged for paths with no backslash', () => {
    expect(parentKeyOf('HKCR')).toBe('HKCR')
  })
})

// ── inferSource ──

describe('inferSource', () => {
  const cases: Array<[string | null, string, string]> = [
    ['C:\\Program Files\\7-Zip\\7-zip.dll', '7-Zip', '7-Zip'],
    ['C:\\Program Files\\WinRAR\\rarext.dll', 'RAR', 'WinRAR'],
    ['C:\\Users\\foo\\AppData\\Local\\Microsoft\\OneDrive\\FileSyncShell64.dll', 'OneDrive', 'OneDrive'],
    ['C:\\Program Files\\Notepad++\\NppShell_06.dll', 'Edit with Notepad++', 'Notepad++'],
    [null, 'Edit with Notepad++', 'Notepad++'],
    ['C:\\Program Files\\Microsoft VS Code\\Code.exe', 'Open with Code', 'VSCode'],
    ['C:\\Program Files\\Git\\bin\\git.exe', 'Git Bash Here', 'Git'],
    ['C:\\Program Files (x86)\\Dropbox\\Client\\DropboxExt.dll', 'Dropbox', 'Dropbox'],
    ['C:\\Windows\\System32\\Sharing.dll', 'Share', 'Microsoft'],
    [null, 'thingFromMars', 'Unknown'],
    [null, '', 'Unknown'],
  ]

  it.each(cases)('infers %s/%s as %s', (dll, key, expected) => {
    expect(inferSource(dll, key)).toBe(expected)
  })
})

// ── parseRegQueryBlocks ──

describe('parseRegQueryBlocks', () => {
  it('parses a single block with multiple values', () => {
    const stdout = [
      'HKEY_CLASSES_ROOT\\*\\shell\\7-Zip',
      '    (Default)    REG_SZ    7-Zip',
      '    MUIVerb    REG_SZ    7-Zip',
      '',
    ].join('\r\n')

    const blocks = parseRegQueryBlocks(stdout)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].keyPath).toBe('HKCR\\*\\shell\\7-Zip')
    expect(blocks[0].values['(Default)']).toEqual({ type: 'REG_SZ', data: '7-Zip' })
    expect(blocks[0].values.MUIVerb).toEqual({ type: 'REG_SZ', data: '7-Zip' })
  })

  it('parses multiple blocks separated by blank lines', () => {
    const stdout = [
      'HKEY_CLASSES_ROOT\\*\\shell\\7-Zip',
      '    (Default)    REG_SZ    7-Zip',
      '',
      'HKEY_CLASSES_ROOT\\*\\shell\\7-Zip\\command',
      '    (Default)    REG_SZ    "C:\\Program Files\\7-Zip\\7zG.exe" "%1"',
      '',
    ].join('\n')

    const blocks = parseRegQueryBlocks(stdout)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].keyPath).toBe('HKCR\\*\\shell\\7-Zip')
    expect(blocks[1].keyPath).toBe('HKCR\\*\\shell\\7-Zip\\command')
    expect(blocks[1].values['(Default)'].data).toBe('"C:\\Program Files\\7-Zip\\7zG.exe" "%1"')
  })

  it('preserves backslashes and embedded characters in data', () => {
    const stdout =
      'HKEY_CLASSES_ROOT\\*\\shellex\\ContextMenuHandlers\\foo\r\n' +
      '    (Default)    REG_SZ    {23170F69-40C1-2702-2401-000100020000}\r\n'

    const blocks = parseRegQueryBlocks(stdout)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].values['(Default)'].data).toBe('{23170F69-40C1-2702-2401-000100020000}')
  })

  it('ignores junk lines without REG_<TYPE>', () => {
    const stdout = [
      'HKEY_CLASSES_ROOT\\*\\shell\\Foo',
      '    (Default)    REG_SZ    Foo',
      'some junk that is not a value',
      '',
    ].join('\n')

    const blocks = parseRegQueryBlocks(stdout)
    expect(blocks).toHaveLength(1)
    expect(Object.keys(blocks[0].values)).toEqual(['(Default)'])
  })

  it('handles empty input', () => {
    expect(parseRegQueryBlocks('')).toEqual([])
  })

  it('parses REG_EXPAND_SZ values', () => {
    const stdout =
      'HKEY_CLASSES_ROOT\\CLSID\\{abc}\\InprocServer32\r\n' +
      '    (Default)    REG_EXPAND_SZ    %SystemRoot%\\System32\\foo.dll\r\n'
    const blocks = parseRegQueryBlocks(stdout)
    expect(blocks[0].values['(Default)']).toEqual({
      type: 'REG_EXPAND_SZ',
      data: '%SystemRoot%\\System32\\foo.dll',
    })
  })
})

// ── SCAN_ROOTS shape ──

describe('SCAN_ROOTS', () => {
  it('covers exactly six scopes across two hives', () => {
    expect(SCAN_ROOTS).toHaveLength(12)
    const hkcr = SCAN_ROOTS.filter((r) => r.hive === 'HKCR')
    const hkcu = SCAN_ROOTS.filter((r) => r.hive === 'HKCU')
    expect(hkcr).toHaveLength(6)
    expect(hkcu).toHaveLength(6)
  })

  it('has matching scopes between HKCR and HKCU', () => {
    const hkcrScopes = SCAN_ROOTS.filter((r) => r.hive === 'HKCR').map((r) => r.scope).sort()
    const hkcuScopes = SCAN_ROOTS.filter((r) => r.hive === 'HKCU').map((r) => r.scope).sort()
    expect(hkcuScopes).toEqual(hkcrScopes)
  })

  it('has no duplicate (hive, scope) pairs', () => {
    const seen = new Set<string>()
    for (const r of SCAN_ROOTS) {
      const key = `${r.hive}|${r.scope}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })

  it('does not include direct HKLM entries', () => {
    for (const r of SCAN_ROOTS) {
      expect(r.shellPath.startsWith('HKLM')).toBe(false)
      expect(r.shellexPath.startsWith('HKLM')).toBe(false)
    }
  })

  it('HKCU mirrors point under Software\\Classes', () => {
    for (const r of SCAN_ROOTS.filter((r) => r.hive === 'HKCU')) {
      expect(r.shellPath.startsWith('HKCU\\Software\\Classes\\')).toBe(true)
      expect(r.shellexPath.startsWith('HKCU\\Software\\Classes\\')).toBe(true)
    }
  })
})

// ── Safelist regression snapshots ──

describe('VERB_SAFELIST', () => {
  it('contains the canonical Windows core verbs', () => {
    for (const verb of ['open', 'edit', 'print', 'properties', 'cut', 'copy', 'paste', 'delete']) {
      expect(VERB_SAFELIST).toContain(verb)
    }
  })

  it('uses lowercase entries', () => {
    for (const v of VERB_SAFELIST) expect(v).toBe(v.toLowerCase())
  })
})

describe('CLSID_SAFELIST', () => {
  it('includes Defender and OneDrive shell extensions', () => {
    expect(CLSID_SAFELIST.length).toBeGreaterThan(5)
    expect(CLSID_SAFELIST.some((c) => c.toUpperCase().includes('09A47860'))).toBe(true) // Defender
    expect(CLSID_SAFELIST.some((c) => c.toUpperCase().includes('CB3D0F55'))).toBe(true) // OneDrive
  })

  it('every entry is a brace-wrapped GUID', () => {
    for (const c of CLSID_SAFELIST) {
      expect(c).toMatch(/^\{[0-9A-Fa-f-]{30,}\}$/)
    }
  })
})
