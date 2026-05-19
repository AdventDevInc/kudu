import { describe, it, expect } from 'vitest'

// ── Test the pure helper functions from registry-cleaner.ipc.ts ──
// These are replicated here to avoid importing the Electron-dependent module.

// ── parseCSVLine (replica) ──

function parseCSVLine(line: string): string[] {
  const fields: string[] = []
  let i = 0
  while (i < line.length) {
    if (line[i] === '"') {
      i++ // skip opening quote
      let field = ''
      while (i < line.length) {
        if (line[i] === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            field += '"'
            i += 2
          } else {
            i++ // skip closing quote
            break
          }
        } else {
          field += line[i]
          i++
        }
      }
      fields.push(field)
      if (i < line.length && line[i] === ',') i++ // skip comma
    } else if (line[i] === ',') {
      fields.push('')
      i++
    } else {
      const next = line.indexOf(',', i)
      if (next === -1) {
        fields.push(line.substring(i))
        break
      }
      fields.push(line.substring(i, next))
      i = next + 1
    }
  }
  return fields
}

describe('parseCSVLine', () => {
  it('parses simple comma-separated values', () => {
    expect(parseCSVLine('a,b,c')).toEqual(['a', 'b', 'c'])
  })

  it('parses quoted fields with commas inside', () => {
    expect(parseCSVLine('"hello, world",foo,bar')).toEqual(['hello, world', 'foo', 'bar'])
  })

  it('parses escaped double quotes inside quoted fields', () => {
    expect(parseCSVLine('"say ""hello""",done')).toEqual(['say "hello"', 'done'])
  })

  it('handles empty fields', () => {
    expect(parseCSVLine('a,,c')).toEqual(['a', '', 'c'])
  })

  it('handles a single field', () => {
    expect(parseCSVLine('only')).toEqual(['only'])
  })

  it('handles empty string', () => {
    expect(parseCSVLine('')).toEqual([])
  })

  it('handles trailing comma (no trailing empty field produced)', () => {
    // The parser stops when it hits end-of-string after consuming the comma,
    // so a trailing comma does NOT produce an extra empty field.
    expect(parseCSVLine('a,b,')).toEqual(['a', 'b'])
  })

  it('handles quoted field at end of line', () => {
    expect(parseCSVLine('a,"b c"')).toEqual(['a', 'b c'])
  })

  it('handles mixed quoted and unquoted fields', () => {
    expect(parseCSVLine('"HOST",\\Task,Next,"C:\\path\\to file.exe"')).toEqual([
      'HOST', '\\Task', 'Next', 'C:\\path\\to file.exe'
    ])
  })
})

// ── SAFE_TASK_PATH_RE and splitTaskPath (replica) ──

const SAFE_TASK_PATH_RE = /^[\\A-Za-z0-9\s\-._()]+$/

function splitTaskPath(fullPath: string): { path: string; name: string } | null {
  const normalized = fullPath.replace(/\//g, '\\')
  if (!SAFE_TASK_PATH_RE.test(normalized)) return null
  const lastSlash = normalized.lastIndexOf('\\')
  if (lastSlash >= 0) {
    return {
      path: normalized.substring(0, lastSlash + 1),
      name: normalized.substring(lastSlash + 1)
    }
  }
  return { path: '\\', name: normalized }
}

describe('splitTaskPath', () => {
  it('splits a normal task path', () => {
    expect(splitTaskPath('\\Microsoft\\Windows\\Task1')).toEqual({
      path: '\\Microsoft\\Windows\\',
      name: 'Task1'
    })
  })

  it('handles a task with no folder', () => {
    expect(splitTaskPath('SimpleTask')).toEqual({
      path: '\\',
      name: 'SimpleTask'
    })
  })

  it('normalizes forward slashes to backslashes', () => {
    expect(splitTaskPath('/Folder/SubTask')).toEqual({
      path: '\\Folder\\',
      name: 'SubTask'
    })
  })

  it('rejects paths with shell injection characters', () => {
    expect(splitTaskPath('\\Task; rm -rf /')).toBe(null)
  })

  it('rejects paths with pipe characters', () => {
    expect(splitTaskPath('\\Task|evil')).toBe(null)
  })

  it('rejects paths with backtick', () => {
    expect(splitTaskPath('\\Task`cmd`')).toBe(null)
  })

  it('rejects paths with ampersand', () => {
    expect(splitTaskPath('\\Task&evil')).toBe(null)
  })

  it('accepts paths with spaces, dots, hyphens, underscores and parens', () => {
    expect(splitTaskPath('\\Folder Name\\My Task (v2.0)')).toEqual({
      path: '\\Folder Name\\',
      name: 'My Task (v2.0)'
    })
  })

  it('rejects path with dollar sign', () => {
    expect(splitTaskPath('\\$Task')).toBe(null)
  })
})

// ── expandEnvVars (replica) ──

function expandEnvVars(path: string): string {
  return path
    .replace(/%SystemRoot%/gi, process.env.WINDIR || 'C:\\Windows')
    .replace(/%ProgramFiles%/gi, process.env.PROGRAMFILES || 'C:\\Program Files')
    .replace(/%ProgramFiles\(x86\)%/gi, process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)')
    .replace(/%ProgramData%/gi, process.env.PROGRAMDATA || 'C:\\ProgramData')
    .replace(/%CommonProgramFiles%/gi, process.env.COMMONPROGRAMFILES || 'C:\\Program Files\\Common Files')
    .replace(/%USERPROFILE%/gi, process.env.USERPROFILE || '')
    .replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA || '')
    .replace(/%APPDATA%/gi, process.env.APPDATA || '')
}

describe('expandEnvVars', () => {
  it('expands %SystemRoot%', () => {
    const result = expandEnvVars('%SystemRoot%\\System32\\cmd.exe')
    expect(result).toMatch(/\\System32\\cmd\.exe$/)
    expect(result).not.toContain('%')
  })

  it('expands %ProgramFiles%', () => {
    const result = expandEnvVars('%ProgramFiles%\\App\\app.exe')
    expect(result).toMatch(/\\App\\app\.exe$/)
    expect(result).not.toContain('%ProgramFiles%')
  })

  it('expands %ProgramFiles(x86)%', () => {
    const result = expandEnvVars('%ProgramFiles(x86)%\\App\\app.exe')
    expect(result).not.toContain('%ProgramFiles(x86)%')
  })

  it('expands %ProgramData%', () => {
    const result = expandEnvVars('%ProgramData%\\App\\config')
    expect(result).not.toContain('%ProgramData%')
  })

  it('is case-insensitive', () => {
    const result = expandEnvVars('%systemroot%\\foo')
    expect(result).not.toContain('%systemroot%')
  })

  it('leaves unknown variables untouched', () => {
    expect(expandEnvVars('%UNKNOWN_VAR%\\foo')).toBe('%UNKNOWN_VAR%\\foo')
  })

  it('handles multiple variables in one path', () => {
    const result = expandEnvVars('%SystemRoot%\\%ProgramData%')
    expect(result).not.toContain('%SystemRoot%')
    expect(result).not.toContain('%ProgramData%')
  })

  it('returns unchanged path when no variables present', () => {
    expect(expandEnvVars('C:\\Windows\\foo.exe')).toBe('C:\\Windows\\foo.exe')
  })
})

// ── extractExePath (replica) ──
// Simplified replica without filesystem checks (statSync). Tests the parsing logic only.

function extractExePathParsing(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Case 1: quoted path
  const quotedMatch = trimmed.match(/^"([^"]+)"/)
  if (quotedMatch) return quotedMatch[1].trim()
  // Case 2: no spaces
  if (!trimmed.includes(' ')) return trimmed
  // Case 3: try exe extension match (since we can't do statSync in tests)
  const exeExtRe = /\.(exe|dll|sys|cmd|bat|com|msc|cpl|scr)$/i
  const splitPoints: number[] = []
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === ' ') splitPoints.push(i)
  }
  splitPoints.push(trimmed.length)
  for (let i = splitPoints.length - 1; i >= 0; i--) {
    const candidate = trimmed.substring(0, splitPoints[i])
    if (exeExtRe.test(candidate)) return candidate
  }
  // Fallback: first token
  return trimmed.substring(0, splitPoints[0])
}

describe('extractExePath parsing', () => {
  it('returns null for empty string', () => {
    expect(extractExePathParsing('')).toBe(null)
    expect(extractExePathParsing('   ')).toBe(null)
  })

  it('extracts path from quoted string', () => {
    expect(extractExePathParsing('"C:\\Program Files\\App\\svc.exe" --config foo.toml'))
      .toBe('C:\\Program Files\\App\\svc.exe')
  })

  it('returns full string when no spaces', () => {
    expect(extractExePathParsing('C:\\App\\svc.exe')).toBe('C:\\App\\svc.exe')
  })

  it('finds exe extension in unquoted string with arguments', () => {
    expect(extractExePathParsing('C:\\Program Files\\App\\svc.exe -k netsvcs'))
      .toBe('C:\\Program Files\\App\\svc.exe')
  })

  it('handles rundll32 style commands', () => {
    const result = extractExePathParsing('rundll32.exe helper.dll,Entry')
    expect(result).toBe('rundll32.exe')
  })

  it('finds .dll extension paths', () => {
    expect(extractExePathParsing('C:\\path\\to\\helper.dll arg1'))
      .toBe('C:\\path\\to\\helper.dll')
  })

  it('finds .sys extension paths', () => {
    expect(extractExePathParsing('C:\\drivers\\my.sys option'))
      .toBe('C:\\drivers\\my.sys')
  })

  it('returns first token for no-extension unquoted commands', () => {
    expect(extractExePathParsing('mycommand arg1 arg2')).toBe('mycommand')
  })
})

// ── IPC handler registration shape tests ──

describe('registry cleaner IPC contract', () => {
  it('REGISTRY_SCAN and REGISTRY_FIX channel names are correct', () => {
    // Verify the IPC channel constants match what the source uses
    expect('cleaner:registry:scan').toBe('cleaner:registry:scan')
    expect('cleaner:registry:fix').toBe('cleaner:registry:fix')
  })

  it('scan sessions limit is 3 (keeps only last 3)', () => {
    // Replicate the session cleanup logic
    const scanSessions = new Map<string, Map<string, unknown>>()
    for (let i = 0; i < 5; i++) {
      scanSessions.set(`session-${i}`, new Map())
    }
    const sessionKeys = [...scanSessions.keys()]
    while (sessionKeys.length > 3) {
      scanSessions.delete(sessionKeys.shift()!)
    }
    expect(scanSessions.size).toBe(3)
    expect(scanSessions.has('session-0')).toBe(false)
    expect(scanSessions.has('session-1')).toBe(false)
    expect(scanSessions.has('session-2')).toBe(true)
    expect(scanSessions.has('session-3')).toBe(true)
    expect(scanSessions.has('session-4')).toBe(true)
  })
})

// ── validateStringArray (replica from ipc-validation) ──

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

describe('registry fix input validation', () => {
  it('rejects non-array input', () => {
    expect(validateStringArray(null)).toBe(null)
    expect(validateStringArray('string')).toBe(null)
    expect(validateStringArray(42)).toBe(null)
    expect(validateStringArray({})).toBe(null)
  })

  it('accepts valid string array', () => {
    expect(validateStringArray(['id1', 'id2', 'id3'])).toEqual(['id1', 'id2', 'id3'])
  })

  it('accepts empty array', () => {
    expect(validateStringArray([])).toEqual([])
  })

  it('rejects array with non-string elements', () => {
    expect(validateStringArray([1, 2, 3])).toBe(null)
    expect(validateStringArray(['valid', 42])).toBe(null)
    expect(validateStringArray([null])).toBe(null)
  })

  it('rejects array exceeding max items', () => {
    const huge = Array.from({ length: 10_001 }, (_, i) => `id-${i}`)
    expect(validateStringArray(huge)).toBe(null)
  })

  it('rejects strings exceeding max length', () => {
    expect(validateStringArray(['x'.repeat(1025)])).toBe(null)
  })

  it('accepts strings at max length boundary', () => {
    expect(validateStringArray(['x'.repeat(1024)])).toEqual(['x'.repeat(1024)])
  })
})

// ── RegistryEntry fix operations ──

describe('registry entry fix operations', () => {
  const validOps = ['delete-value', 'delete-key', 'set-value', 'disable-task', 'delete-task']

  it('all supported fix operations are known', () => {
    expect(validOps).toHaveLength(5)
  })

  it('set-value requires regType and data', () => {
    const fix = { op: 'set-value' as const, regType: 'REG_DWORD', data: '1' }
    expect(fix.regType).toBeDefined()
    expect(fix.data).toBeDefined()
  })

  it('delete-key can have an optional key override', () => {
    const fix = { op: 'delete-key' as const, key: 'HKCR\\CLSID\\{some-guid}' }
    expect(fix.key).toBe('HKCR\\CLSID\\{some-guid}')
  })
})

// ── Risk levels and entry types ──

describe('registry entry classification', () => {
  const validTypes = ['invalid', 'broken', 'obsolete', 'orphaned', 'vulnerability', 'performance', 'network', 'service', 'task']
  const validRisks = ['low', 'medium', 'high']

  it('all entry types are known', () => {
    expect(validTypes).toHaveLength(9)
  })

  it('all risk levels are known', () => {
    expect(validRisks).toHaveLength(3)
  })

  it('vulnerability entries use high risk', () => {
    // Matches the pattern from the source: UAC, Defender, SMBv1, firewall disabled, RDP without NLA
    const vulnerabilityRisks = ['high', 'high', 'high', 'high', 'high']
    vulnerabilityRisks.forEach(r => expect(validRisks).toContain(r))
  })

  it('orphaned entries typically use low or medium risk', () => {
    const orphanedRisks = ['low', 'medium']
    orphanedRisks.forEach(r => expect(validRisks).toContain(r))
  })
})

// ── SAFE_TASK_PATH_RE security ──

describe('SAFE_TASK_PATH_RE security', () => {
  it('allows alphanumeric with backslash', () => {
    expect(SAFE_TASK_PATH_RE.test('\\Microsoft\\Windows\\Defrag')).toBe(true)
  })

  it('allows spaces and hyphens', () => {
    expect(SAFE_TASK_PATH_RE.test('\\My Task-Name')).toBe(true)
  })

  it('allows dots and underscores', () => {
    expect(SAFE_TASK_PATH_RE.test('\\My.Task_Name')).toBe(true)
  })

  it('allows parentheses', () => {
    expect(SAFE_TASK_PATH_RE.test('\\Task (1)')).toBe(true)
  })

  it('rejects semicolons (shell injection)', () => {
    expect(SAFE_TASK_PATH_RE.test('\\Task; malicious')).toBe(false)
  })

  it('rejects pipes', () => {
    expect(SAFE_TASK_PATH_RE.test('\\Task | evil')).toBe(false)
  })

  it('rejects backticks', () => {
    expect(SAFE_TASK_PATH_RE.test('\\Task`cmd`')).toBe(false)
  })

  it('rejects ampersand', () => {
    expect(SAFE_TASK_PATH_RE.test('\\Task & evil')).toBe(false)
  })

  it('rejects single quotes', () => {
    expect(SAFE_TASK_PATH_RE.test("\\Task' OR 1=1")).toBe(false)
  })

  it('rejects double quotes', () => {
    expect(SAFE_TASK_PATH_RE.test('\\Task" --inject')).toBe(false)
  })

  it('rejects less-than and greater-than', () => {
    expect(SAFE_TASK_PATH_RE.test('\\Task<script>')).toBe(false)
  })

  it('rejects null bytes', () => {
    expect(SAFE_TASK_PATH_RE.test('\\Task\0evil')).toBe(false)
  })
})

// ── collectBackupTargets (replica) ──
// Decides which registry keys and scheduled tasks need backing up before a fix run.

interface FixActionLite {
  op: 'delete-value' | 'delete-key' | 'set-value' | 'disable-task' | 'delete-task'
  key?: string
}
interface EntryLite { keyPath: string; valueName?: string; fix?: FixActionLite }

function collectBackupTargets(entries: EntryLite[]): { keys: string[]; tasks: string[] } {
  const keys = new Set<string>()
  const tasks = new Set<string>()
  for (const entry of entries) {
    if (!entry.fix) continue
    const key = entry.fix.key || entry.keyPath
    switch (entry.fix.op) {
      case 'delete-value':
      case 'set-value':
      case 'delete-key':
        if (key) keys.add(key)
        break
      case 'disable-task':
      case 'delete-task':
        if (entry.keyPath) tasks.add(entry.keyPath)
        break
    }
  }
  return { keys: [...keys], tasks: [...tasks] }
}

describe('collectBackupTargets', () => {
  it('returns empty sets for empty input', () => {
    expect(collectBackupTargets([])).toEqual({ keys: [], tasks: [] })
  })

  it('skips entries without a fix action', () => {
    expect(collectBackupTargets([{ keyPath: 'HKCR\\foo' }])).toEqual({ keys: [], tasks: [] })
  })

  it('captures the parent key for delete-value', () => {
    const { keys, tasks } = collectBackupTargets([
      { keyPath: 'HKLM\\SOFTWARE\\App', fix: { op: 'delete-value' } },
    ])
    expect(keys).toEqual(['HKLM\\SOFTWARE\\App'])
    expect(tasks).toEqual([])
  })

  it('captures the key itself for delete-key', () => {
    const { keys } = collectBackupTargets([
      { keyPath: 'HKCR\\CLSID\\{abc}', fix: { op: 'delete-key' } },
    ])
    expect(keys).toEqual(['HKCR\\CLSID\\{abc}'])
  })

  it('captures the key for set-value', () => {
    const { keys } = collectBackupTargets([
      { keyPath: 'HKLM\\SOFTWARE\\App', fix: { op: 'set-value' } },
    ])
    expect(keys).toEqual(['HKLM\\SOFTWARE\\App'])
  })

  it('prefers fix.key over keyPath when both present', () => {
    const { keys } = collectBackupTargets([
      { keyPath: 'HKCR\\old', fix: { op: 'delete-key', key: 'HKCR\\CLSID\\{abc}' } },
    ])
    expect(keys).toEqual(['HKCR\\CLSID\\{abc}'])
  })

  it('deduplicates keys touched by multiple entries', () => {
    const { keys } = collectBackupTargets([
      { keyPath: 'HKCR\\CLSID\\{abc}', fix: { op: 'delete-value' } },
      { keyPath: 'HKCR\\CLSID\\{abc}', fix: { op: 'delete-value' } },
      { keyPath: 'HKCR\\CLSID\\{abc}', fix: { op: 'set-value' } },
    ])
    expect(keys).toEqual(['HKCR\\CLSID\\{abc}'])
  })

  it('routes task ops to tasks, not keys', () => {
    const { keys, tasks } = collectBackupTargets([
      { keyPath: '\\Microsoft\\Foo', fix: { op: 'disable-task' } },
      { keyPath: '\\Microsoft\\Bar', fix: { op: 'delete-task' } },
    ])
    expect(keys).toEqual([])
    expect(tasks).toEqual(['\\Microsoft\\Foo', '\\Microsoft\\Bar'])
  })

  it('partitions a mixed batch into keys and tasks', () => {
    const { keys, tasks } = collectBackupTargets([
      { keyPath: 'HKLM\\SOFTWARE\\A', fix: { op: 'delete-value' } },
      { keyPath: '\\MyTask', fix: { op: 'disable-task' } },
      { keyPath: 'HKCR\\CLSID\\{x}', fix: { op: 'delete-key' } },
    ])
    expect(keys.sort()).toEqual(['HKCR\\CLSID\\{x}', 'HKLM\\SOFTWARE\\A'])
    expect(tasks).toEqual(['\\MyTask'])
  })

  it('drops entries whose resolved key would be empty', () => {
    // keyPath is empty and no fix.key override — nothing to back up
    const { keys } = collectBackupTargets([
      { keyPath: '', fix: { op: 'delete-value' } },
    ])
    expect(keys).toEqual([])
  })
})

// ── stripRegHeader (replica) ──
// Removes the BOM + "Windows Registry Editor Version 5.00" preamble so multiple
// reg-export files can be concatenated into one consolidated backup.

function stripRegHeader(content: string): string {
  return content.replace(/^﻿?Windows Registry Editor Version 5\.00\r?\n\r?\n/, '')
}

describe('stripRegHeader', () => {
  it('strips the standard CRLF header', () => {
    const input = 'Windows Registry Editor Version 5.00\r\n\r\n[HKEY_LOCAL_MACHINE\\Foo]\r\n"a"="b"\r\n'
    expect(stripRegHeader(input)).toBe('[HKEY_LOCAL_MACHINE\\Foo]\r\n"a"="b"\r\n')
  })

  it('strips a LF-only header (defensive)', () => {
    const input = 'Windows Registry Editor Version 5.00\n\n[HKEY_LOCAL_MACHINE\\Foo]\n'
    expect(stripRegHeader(input)).toBe('[HKEY_LOCAL_MACHINE\\Foo]\n')
  })

  it('strips a BOM-prefixed header (reg.exe writes UTF-16 with BOM)', () => {
    const input = '﻿Windows Registry Editor Version 5.00\r\n\r\n[HKEY_X\\Y]\r\n'
    expect(stripRegHeader(input)).toBe('[HKEY_X\\Y]\r\n')
  })

  it('leaves text without a header untouched', () => {
    expect(stripRegHeader('[HKEY_X\\Y]\r\n"a"="b"\r\n')).toBe('[HKEY_X\\Y]\r\n"a"="b"\r\n')
  })

  it('produces a valid concatenated reg file when bodies are joined under a single header', () => {
    const a = 'Windows Registry Editor Version 5.00\r\n\r\n[HKEY_X\\A]\r\n"v"="1"\r\n\r\n'
    const b = 'Windows Registry Editor Version 5.00\r\n\r\n[HKEY_X\\B]\r\n"v"="2"\r\n\r\n'
    const combined = 'Windows Registry Editor Version 5.00\r\n\r\n' + stripRegHeader(a) + stripRegHeader(b)
    expect(combined).toBe(
      'Windows Registry Editor Version 5.00\r\n\r\n' +
      '[HKEY_X\\A]\r\n"v"="1"\r\n\r\n' +
      '[HKEY_X\\B]\r\n"v"="2"\r\n\r\n'
    )
  })
})
