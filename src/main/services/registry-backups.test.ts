import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'

const mocks = vi.hoisted(() => ({
  native: vi.fn(),
  tracked: vi.fn(),
  admin: vi.fn(() => true),
  dir: '',
  sealedDir: '',
  /** Seals as recorded in HKLM: lower-cased file name → sha256 hex. */
  seals: new Map<string, string>(),
  sealBackup: vi.fn(),
  removeSeal: vi.fn(),
  privateTemp: vi.fn()
}))
vi.mock('./exec-utf8', () => ({
  execNativeUtf8: mocks.native,
  execTracked: mocks.tracked,
  psUtf8: (v: string) => v
}))
vi.mock('./elevation', () => ({ isAdmin: mocks.admin }))
vi.mock('./backup-dir', () => ({ getBackupDir: () => mocks.dir }))
vi.mock('./registry-backup-seal', () => {
  const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  return {
    sha256Hex,
    sealBackup: mocks.sealBackup,
    createPrivateTempDir: mocks.privateTemp,
    // Seals are namespaced by backup folder; every seal in these tests belongs to `dir`.
    readSeals: async (d: string) => (d === mocks.sealedDir ? new Map(mocks.seals) : new Map()),
    // Like the real helpers: only seals that exist are removed, via removeSeal.
    removeSeals: async (d: string, names: string[]) => {
      for (const n of names) if (mocks.seals.has(n.toLowerCase())) await mocks.removeSeal(d, n)
    },
    sweepSeals: async (d: string, seals: Map<string, string>, present: Set<string>) => {
      const kept = new Map<string, string>()
      for (const [n, h] of seals) {
        if (present.has(n)) kept.set(n, h)
        else await mocks.removeSeal(d, n)
      }
      return kept
    }
  }
})

import {
  assessRegistryBackup,
  buildTombstones,
  classifyBackupName,
  listRegistryBackups,
  parseRegExport,
  regValueName,
  resolveBackupFile,
  restoreRegistryBackup,
  topLevelKeys
} from './registry-backups'

const HEADER = 'Windows Registry Editor Version 5.00'
const TARGETED = 'registry-backup-targeted-2026-09-20T04-54-02-325Z.reg'
const PRE = 'pre-restore-backup-2026-09-20T04-54-02-325Z.reg'
const RUN = 'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run'
const DNS = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\DNSClient'

/** Encode like `reg export`: UTF-16LE with a BOM and CRLF line endings. */
function regText(lines: string[], header = HEADER): Buffer {
  const text = [header, '', ...lines, ''].join('\r\n')
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
}
function regFile(sections: string[], header = HEADER): Buffer {
  return regText(
    sections.flatMap((s) => [s, '"Value"="data"', '']),
    header
  )
}
const keysFile = (keys: string[]) => regFile(keys.map((k) => `[${k}]`))
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
/** Record a seal for a file already in the backup folder, as Kudu would when writing it. */
const seal = (name: string) =>
  mocks.seals.set(name.toLowerCase(), sha(readFileSync(join(dir, name))))

const platform = process.platform
let dir: string
let outside: string
let privateDirs: string[]

beforeEach(() => {
  vi.resetAllMocks()
  mocks.admin.mockReturnValue(true)
  mocks.seals.clear()
  mocks.sealBackup.mockImplementation(async (_d: string, name: string, bytes: Buffer) => {
    mocks.seals.set(name.toLowerCase(), sha(bytes))
    return true
  })
  mocks.removeSeal.mockImplementation(async (_d: string, name: string) => {
    mocks.seals.delete(name.toLowerCase())
  })
  privateDirs = []
  mocks.privateTemp.mockImplementation(async (prefix: string) => {
    const path = mkdtempSync(join(tmpdir(), prefix))
    privateDirs.push(path)
    return path
  })
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  dir = mkdtempSync(join(tmpdir(), 'kudu-reg-backups-'))
  outside = mkdtempSync(join(tmpdir(), 'kudu-reg-outside-'))
  mocks.dir = dir
  mocks.sealedDir = dir
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  for (const p of privateDirs) rmSync(p, { recursive: true, force: true })
})

describe('parseRegExport', () => {
  it('reads sections and unescaped value names from a UTF-16LE export with a BOM', () => {
    const parsed = parseRegExport(
      regText([
        `[${RUN}]`,
        '@="default"',
        '"a\\"b\\\\c"="x\\"y\\\\z"',
        '"n"=dword:00000001',
        '"bin"=hex:01,02,\\',
        '  03,04',
        '"none"=hex(0):',
        '',
        `[${RUN}\\Sub]x]`,
        ''
      ])
    )
    expect(parsed).toEqual({
      ok: true,
      keys: [RUN, RUN + '\\Sub]x'],
      sections: [
        { key: RUN, deleted: false, values: ['', 'a"b\\c', 'n', 'bin', 'none'], deletedValues: [] },
        { key: RUN + '\\Sub]x', deleted: false, values: [], deletedValues: [] }
      ]
    })
  })

  it('rejects files without the BOM, in UTF-8, or with another header', () => {
    const utf16NoBom = Buffer.from(`${HEADER}\r\n\r\n[${RUN}]\r\n`, 'utf16le')
    expect(parseRegExport(utf16NoBom)).toEqual({ ok: false, reason: 'format' })
    expect(parseRegExport(Buffer.from(`${HEADER}\r\n\r\n[${RUN}]\r\n`, 'utf8'))).toEqual({
      ok: false,
      reason: 'format'
    })
    expect(parseRegExport(regFile([`[${RUN}]`], 'REGEDIT4'))).toEqual({
      ok: false,
      reason: 'format'
    })
  })

  it.each([
    // reg export writes a string's embedded newlines raw; reg import would read the
    // following lines as entries of their own.
    ['a string spanning lines', [`[${RUN}]`, '"v"="foo', '@=dword:00000001', 'bar"']],
    ['a stray carriage return', [`[${RUN}]`, '"v"="a\rb"']],
    ['an unknown escape', [`[${RUN}]`, '"v"="a\\nb"']],
    ['a value before any key', ['"v"="a"', `[${RUN}]`]],
    ['an unterminated hex continuation', [`[${RUN}]`, '"v"=hex:01,\\']],
    ['a malformed hex continuation', [`[${RUN}]`, '"v"=hex:01,\\', '  zz']],
    ['an unknown data type', [`[${RUN}]`, '"v"=qword:1']],
    ['a comment or junk line', [`[${RUN}]`, '; hello']]
  ])('rejects %s as not in the export format', (_label, lines) => {
    expect(parseRegExport(regText(lines))).toEqual({ ok: false, reason: 'format' })
  })

  it('refuses key and value deletions unless allowed', () => {
    expect(parseRegExport(keysFile([RUN, '-' + DNS]))).toEqual({ ok: false, reason: 'deletion' })
    const valueDelete = regFile([`[${RUN}]\r\n"Evil"=-`])
    expect(parseRegExport(valueDelete)).toEqual({ ok: false, reason: 'deletion' })
    expect(parseRegExport(regText([`[${RUN}]`, '@=-']))).toEqual({
      ok: false,
      reason: 'deletion'
    })

    const tombstones = regText([`[-${DNS}]`, '', `[${RUN}]`, '@=-', '"a\\"b"=-', ''])
    expect(parseRegExport(tombstones, true)).toEqual({
      ok: true,
      keys: [DNS, RUN],
      sections: [
        { key: DNS, deleted: true, values: [], deletedValues: [] },
        { key: RUN, deleted: false, values: [], deletedValues: ['', 'a"b'] }
      ]
    })
    // A deleted key has no values of its own.
    expect(parseRegExport(regText([`[-${DNS}]`, '"v"="x"']), true)).toEqual({
      ok: false,
      reason: 'format'
    })
  })

  it('reports files with no keys as empty', () => {
    expect(parseRegExport(regFile([]))).toEqual({ ok: false, reason: 'empty' })
  })
})

describe('regValueName', () => {
  it('quotes names the way reg export does', () => {
    expect(regValueName('')).toBe('@')
    expect(regValueName('plain')).toBe('"plain"')
    expect(regValueName('a"b\\c')).toBe('"a\\"b\\\\c"')
  })
})

describe('topLevelKeys', () => {
  it('keeps only keys with no ancestor in the file', () => {
    expect(topLevelKeys([RUN, RUN + '\\A', RUN + '\\A\\B', DNS, RUN.toLowerCase()])).toEqual([
      RUN,
      DNS
    ])
  })
})

describe('assessRegistryBackup', () => {
  it('accepts a sealed targeted backup and always flags it as needing admin', () => {
    const assessment = assessRegistryBackup(TARGETED, keysFile([RUN, RUN + '\\Sub', DNS]), true)
    expect(assessment).toMatchObject({ keys: [RUN, DNS], requiresAdmin: true })
    expect(assessment.blocked).toBeUndefined()
    // HKCU-only too: sealing the pre-restore backup and the private folder need elevation.
    expect(assessRegistryBackup(TARGETED, keysFile([RUN]), true).requiresAdmin).toBe(true)
  })

  it('marks an otherwise valid backup without a matching seal as unverified', () => {
    expect(assessRegistryBackup(TARGETED, keysFile([RUN]), false).blocked).toBe('unverified')
    // Content problems are reported first.
    expect(
      assessRegistryBackup(TARGETED, keysFile(['HKEY_LOCAL_MACHINE\\SAM']), false).blocked
    ).toBe('forbidden-key')
  })

  it('allows tombstones only in sealed pre-restore backups', () => {
    const tombstones = regText([`[-${DNS}]`, '', `[${RUN}]`, '"Value"=-', ''])
    const sealed = assessRegistryBackup(PRE, tombstones, true)
    expect(sealed).toMatchObject({ keys: [DNS, RUN], requiresAdmin: true })
    expect(sealed.blocked).toBeUndefined()
    expect(assessRegistryBackup(PRE, tombstones, false).blocked).toBe('deletion')
    for (const name of [TARGETED, 'privacy-traces-backup-2026-09-20T04-54-02-325Z.reg'])
      expect(assessRegistryBackup(name, tombstones, true).blocked).toBe('deletion')
  })

  it('refuses tombstones for branch roots or keys outside the scopes', () => {
    for (const key of [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft',
      'HKEY_CLASSES_ROOT\\CLSID',
      'HKEY_LOCAL_MACHINE\\SOFTWARE'
    ]) {
      // Nested under an exported key, so only the tombstone check can catch it.
      const file = regText([`[${key}\\Child]`, '', `[-${key}]`, ''])
      expect(assessRegistryBackup(PRE, file, true).blocked).toBe('forbidden-key')
    }
    for (const key of [
      // A scope root that is not otherwise a branch root.
      'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server',
      'HKEY_LOCAL_MACHINE\\SYSTEM\\Setup\\Evil',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
    ])
      expect(assessRegistryBackup(PRE, regText([`[-${key}]`, '']), true).blocked).toBe(
        'forbidden-key'
      )
  })

  it.each([
    'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager',
    'HKEY_LOCAL_MACHINE\\SYSTEM\\ControlSet001\\Control\\Session Manager\\Environment',
    'HKEY_LOCAL_MACHINE\\SAM\\SAM',
    'HKEY_LOCAL_MACHINE\\SECURITY\\Policy',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\a.exe',
    'HKEY_LOCAL_MACHINE\\SYSTEM\\Setup',
    'HKEY_USERS\\S-1-5-18\\Software\\Foo',
    'HKEY_CURRENT_CONFIG\\Software\\Foo'
  ])('refuses %s', (key) => {
    expect(assessRegistryBackup(TARGETED, keysFile([RUN, key]), true).blocked).toBe('forbidden-key')
  })

  it('limits each source to the branches it writes', () => {
    const name = 'privacy-traces-backup-2026-09-20T04-54-02-325Z.reg'
    expect(assessRegistryBackup(name, keysFile([RUN]), true).blocked).toBeUndefined()
    expect(assessRegistryBackup(name, keysFile([DNS]), true).blocked).toBe('forbidden-key')
  })

  it('treats full-branch exports as not restorable, by name or by breadth', () => {
    const full = 'registry-backup-HKCU-2026-09-20T04-54-02-325Z.reg'
    expect(assessRegistryBackup(full, keysFile([RUN]), true).blocked).toBe('full-export')
    for (const root of [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node',
      'HKEY_CURRENT_USER\\SOFTWARE\\Classes',
      'HKEY_CLASSES_ROOT\\CLSID',
      'HKEY_CLASSES_ROOT\\*\\shellex',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\CLSID',
      'HKEY_CURRENT_USER\\SOFTWARE\\Classes\\Directory\\shell',
      'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services'
    ])
      expect(assessRegistryBackup(TARGETED, keysFile([root, root + '\\Child']), true).blocked).toBe(
        'full-export'
      )
    for (const root of ['HKEY_LOCAL_MACHINE\\SOFTWARE', 'HKEY_CLASSES_ROOT'])
      expect(assessRegistryBackup(TARGETED, keysFile([root]), true).blocked).toBe('full-export')
    const many = Array.from({ length: 10_001 }, (_, i) => `${RUN}\\K${i}`)
    expect(assessRegistryBackup(TARGETED, keysFile([RUN, ...many]), true).blocked).toBe(
      'full-export'
    )
    expect(
      assessRegistryBackup(
        TARGETED,
        keysFile(['HKEY_CURRENT_USER\\SOFTWARE\\Classes\\CLSID\\{1234}']),
        true
      ).blocked
    ).toBeUndefined()
  })

  it('refuses HKEY_CLASSES_ROOT keys: the merged view hides which hive they belong to', () => {
    const clsid = 'HKEY_CLASSES_ROOT\\CLSID\\{1234}'
    for (const keys of [[clsid], [RUN, clsid + '\\InprocServer32']])
      expect(assessRegistryBackup(TARGETED, keysFile(keys), true).blocked).toBe('classes-root')
    // Pre-restore snapshots too, sealed or not.
    expect(assessRegistryBackup(PRE, keysFile([clsid]), true).blocked).toBe('classes-root')
    // The backing keys are fine.
    for (const key of [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\CLSID\\{1234}',
      'HKEY_CURRENT_USER\\SOFTWARE\\Classes\\CLSID\\{1234}'
    ])
      expect(assessRegistryBackup(TARGETED, keysFile([key]), true).blocked).toBeUndefined()
  })
})

describe('classifyBackupName', () => {
  it('maps filename prefixes to sources, with only targeted names restorable', () => {
    expect(classifyBackupName(TARGETED)).toEqual({ source: 'registry', targeted: true })
    expect(classifyBackupName('registry-backup-2026-09-20T04-54-02-325Z.reg')).toEqual({
      source: 'registry',
      targeted: false
    })
    expect(
      classifyBackupName('registry-backup-context-menu-Directory-2026-09-20T04-54-02-325Z.reg')
    ).toEqual({ source: 'context-menu', targeted: false })
    expect(classifyBackupName(PRE)).toEqual({ source: 'pre-restore', targeted: true })
  })
})

describe('buildTombstones', () => {
  const state = (entries: Record<string, string[] | null>) =>
    new Map(
      Object.entries(entries).map(([k, names]) => [
        k.toUpperCase(),
        { exists: names !== null, present: new Set((names ?? []).map((n) => n.toLowerCase())) }
      ])
    )
  const section = (key: string, values: string[] = []) => ({
    key,
    deleted: false,
    values,
    deletedValues: []
  })

  it('deletes absent keys once per branch and absent values with reg-export escaping', () => {
    const text = buildTombstones(
      [
        section(RUN, ['', 'a"b\\c', 'Kept', 'gone']),
        section(RUN + '\\New', ['x']),
        section(RUN + '\\New\\Deeper'),
        section(DNS, ['v'])
      ],
      state({
        [RUN]: ['kept'],
        [RUN + '\\New']: null,
        [RUN + '\\New\\Deeper']: null,
        [DNS]: ['V']
      })
    )
    expect(text).toBe(
      `[-${RUN}\\New]\r\n\r\n` + `[${RUN}]\r\n@=-\r\n"a\\"b\\\\c"=-\r\n"gone"=-\r\n\r\n`
    )
  })

  it('records nothing when every key and value already exists', () => {
    expect(buildTombstones([section(RUN, ['v'])], state({ [RUN]: ['v'] }))).toBe('')
  })
})

describe('listRegistryBackups', () => {
  it('lists only Kudu-prefixed .reg files, newest first', async () => {
    const files: Record<string, Buffer> = {
      [TARGETED]: keysFile([RUN, DNS]),
      'registry-backup-2026-09-19T04-54-02-325Z.reg': keysFile(['HKEY_LOCAL_MACHINE\\SOFTWARE']),
      'registry-backup-context-menu-Folder-shell-2026-09-18T04-54-02-325Z.reg': keysFile([
        'HKEY_CLASSES_ROOT\\Folder\\shell'
      ]),
      'privacy-traces-backup-2026-09-17T04-54-02-325Z.reg': keysFile([RUN]),
      'pre-restore-backup-2026-09-16T04-54-02-325Z.reg': keysFile(['-' + RUN]),
      'pre-restore-backup-2026-09-15T04-54-02-325Z.reg': regText([`[-${RUN}]`, '']),
      'registry-backup-targeted-2026-09-14T04-54-02-325Z.reg': keysFile([RUN]),
      'registry-backup-targeted-2026-09-13T04-54-02-325Z.reg': keysFile([RUN]),
      'someone-elses.reg': keysFile([RUN]),
      'registry-backup-notes.txt': keysFile([RUN])
    }
    let day = 20
    for (const [name, buf] of Object.entries(files)) {
      writeFileSync(join(dir, name), buf)
      const time = new Date(`2026-09-${day--}T00:00:00Z`)
      utimesSync(join(dir, name), time, time)
    }
    mkdirSync(join(dir, 'registry-backup-tasks-2026-09-20T04-54-02-325Z'))
    seal(TARGETED)
    seal('pre-restore-backup-2026-09-15T04-54-02-325Z.reg')
    seal('registry-backup-targeted-2026-09-14T04-54-02-325Z.reg')
    // Sealed, then changed by someone else.
    seal('registry-backup-targeted-2026-09-13T04-54-02-325Z.reg')
    const tampered = join(dir, 'registry-backup-targeted-2026-09-13T04-54-02-325Z.reg')
    writeFileSync(tampered, keysFile([RUN + '\\Evil']))
    utimesSync(tampered, new Date('2026-09-13T00:00:00Z'), new Date('2026-09-13T00:00:00Z'))

    const list = await listRegistryBackups()
    expect(list.map((b) => [b.name, b.source, b.restorable, b.blocked])).toEqual([
      [TARGETED, 'registry', true, undefined],
      ['registry-backup-2026-09-19T04-54-02-325Z.reg', 'registry', false, 'full-export'],
      [
        'registry-backup-context-menu-Folder-shell-2026-09-18T04-54-02-325Z.reg',
        'context-menu',
        false,
        'full-export'
      ],
      ['privacy-traces-backup-2026-09-17T04-54-02-325Z.reg', 'privacy-traces', false, 'unverified'],
      ['pre-restore-backup-2026-09-16T04-54-02-325Z.reg', 'pre-restore', false, 'deletion'],
      ['pre-restore-backup-2026-09-15T04-54-02-325Z.reg', 'pre-restore', true, undefined],
      ['registry-backup-targeted-2026-09-14T04-54-02-325Z.reg', 'registry', true, undefined],
      ['registry-backup-targeted-2026-09-13T04-54-02-325Z.reg', 'registry', false, 'unverified']
    ])
    expect(list[0]).toMatchObject({ keys: [RUN, DNS], keyCount: 2, requiresAdmin: true })
    // Every restorable backup needs admin, HKCU-only ones included.
    expect(list.filter((b) => b.restorable).every((b) => b.requiresAdmin)).toBe(true)
    expect(list[6]).toMatchObject({ keys: [RUN], restorable: true, requiresAdmin: true })
    // Full exports are never parsed in full; the export root comes from the file head.
    expect(list[1].keys).toEqual(['HKEY_LOCAL_MACHINE\\SOFTWARE'])
  })

  it('drops the seals of deleted backups, so a file put back later stays unverified', async () => {
    const gone = 'registry-backup-targeted-2026-09-14T04-54-02-325Z.reg'
    writeSealed(TARGETED, keysFile([RUN]))
    writeSealed(gone, keysFile([RUN]))
    const bytes = readFileSync(join(dir, gone))
    rmSync(join(dir, gone))

    await listRegistryBackups()

    expect(mocks.removeSeal.mock.calls).toEqual([[dir, gone.toLowerCase()]])
    expect([...mocks.seals.keys()]).toEqual([TARGETED.toLowerCase()])
    // An unelevated process that kept the bytes puts the file back.
    writeFileSync(join(dir, gone), bytes)
    const list = await listRegistryBackups()
    expect(list.find((b) => b.name === gone)).toMatchObject({
      restorable: false,
      blocked: 'unverified'
    })
    expect(list.find((b) => b.name === TARGETED)).toMatchObject({ restorable: true })
  })

  it('keeps the seals of a previous backup folder when the folder changes', async () => {
    writeSealed(TARGETED, keysFile([RUN]))
    // The user points Kudu at another, existing folder and opens Recovery.
    mocks.dir = outside
    writeFileSync(join(outside, 'registry-backup-targeted-2026-09-14T04-54-02-325Z.reg'), '')
    await listRegistryBackups()
    expect(mocks.removeSeal).not.toHaveBeenCalled()
    // Back to the first folder: its backup is still verified.
    mocks.dir = dir
    const [backup] = await listRegistryBackups()
    expect(backup).toMatchObject({ name: TARGETED, restorable: true })
  })

  it('returns nothing off Windows or when the folder does not exist', async () => {
    writeFileSync(join(dir, TARGETED), keysFile([RUN]))
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(await listRegistryBackups()).toEqual([])
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    mocks.dir = join(dir, 'missing')
    expect(await listRegistryBackups()).toEqual([])
  })
})

describe('resolveBackupFile', () => {
  it.each([
    ['a path outside the folder', '../' + TARGETED],
    ['a nested path', 'sub/' + TARGETED],
    ['a Windows nested path', 'sub\\' + TARGETED],
    ['an unknown prefix', 'someone-elses.reg'],
    ['a non-string', 42]
  ])('rejects %s', async (_label, name) => {
    await expect(resolveBackupFile(name)).rejects.toThrow('Invalid backup name')
  })

  it('rejects directories', async () => {
    mkdirSync(join(dir, TARGETED))
    await expect(resolveBackupFile(TARGETED)).rejects.toThrow('not a regular file')
  })

  it('rejects symlinks to files outside the folder', async (ctx) => {
    writeFileSync(join(outside, 'target.reg'), keysFile([RUN]))
    try {
      symlinkSync(join(outside, 'target.reg'), join(dir, TARGETED), 'file')
    } catch {
      // Creating file symlinks needs Developer Mode or elevation on Windows.
      ctx.skip()
    }
    await expect(resolveBackupFile(TARGETED)).rejects.toThrow('not a regular file')
  })

  it('accepts a regular file directly inside the folder', async () => {
    writeFileSync(join(dir, TARGETED), keysFile([RUN]))
    await expect(resolveBackupFile(TARGETED)).resolves.toMatchObject({ dir })
  })
})

/** Registry as the probe sees it: key → value names it holds. Keys not listed are absent. */
let registry: Record<string, string[]> = {}
type ProbeItem = { k: string; n: string[] }
function probeItems(args: string[]): ProbeItem[] {
  const script = args.at(-1) as string
  const payload = /FromBase64String\('([^']+)'\)/.exec(script)![1]!
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
}
/** Parents that exist on any machine unless a test says otherwise. */
const parentsOf = (keys: string[]) =>
  keys.flatMap((k) => {
    const parts = k.split('\\')
    return parts.slice(1, -1).map((_, i) => parts.slice(0, i + 2).join('\\'))
  })
let baseline: string[] = []
beforeEach(() => {
  baseline = parentsOf([RUN, DNS])
})
function answerProbe(args: string[]) {
  const answers = probeItems(args).map(({ k, n }) => {
    const upper = k.toUpperCase()
    const entry = Object.entries(registry).find(([key]) => key.toUpperCase() === upper)
    // A key exists when listed, when it is a parent of a listed key, or in the baseline.
    const parentOfListed = Object.keys(registry).some((key) =>
      key.toUpperCase().startsWith(upper + '\\')
    )
    if (!entry && (parentOfListed || baseline.some((b) => b.toUpperCase() === upper)))
      return '1' + '0'.repeat(n.length)
    if (!entry) return '0'.repeat(n.length + 1)
    const has = new Set(entry[1].map((v) => v.toLowerCase()))
    return '1' + n.map((name) => (has.has(name.toLowerCase()) ? '1' : '0')).join('')
  })
  return { stdout: JSON.stringify(answers), stderr: '' }
}

describe('restoreRegistryBackup', () => {
  const importCalls = () => mocks.native.mock.calls.filter((c) => c[1][0] === 'import')
  const exportCalls = () => mocks.native.mock.calls.filter((c) => c[1][0] === 'export')
  const preRestoreFiles = () => readdirSync(dir).filter((f) => f.startsWith('pre-restore-backup-'))

  let imported: Buffer | null = null
  /** The probe answers from `present`; exports write a small file; imports succeed. */
  function simulate(present: Record<string, string[]>, failExport?: string) {
    imported = null
    registry = present
    mocks.tracked.mockImplementation(async (_tool: string, args: string[]) => answerProbe(args))
    mocks.native.mockImplementation(async (_tool: string, args: string[]) => {
      if (args[0] === 'export') {
        if (args[1] === failExport) throw new Error('ERROR: Access is denied.')
        const long = args[1]
          .replace(/^HKCU/, 'HKEY_CURRENT_USER')
          .replace(/^HKLM/, 'HKEY_LOCAL_MACHINE')
        writeFileSync(args[2], keysFile([long + '-now']))
      }
      if (args[0] === 'import') imported = readFileSync(args[1])
      return { stdout: '', stderr: '' }
    })
  }
  const callOrder = (call: unknown[]) =>
    mocks.native.mock.invocationCallOrder[mocks.native.mock.calls.indexOf(call)]

  it('backs up existing keys, then imports a validated copy of the file', async () => {
    writeSealed(TARGETED, keysFile([RUN, DNS]))
    simulate({ [RUN]: ['Value'] })

    const result = await restoreRegistryBackup(TARGETED)

    // Only the key that exists is exported, in short form, before the import runs.
    expect(exportCalls().map((c) => c[1][1])).toEqual([
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run'
    ])
    // The import reads a private copy holding exactly the validated bytes.
    const [imp] = importCalls()
    expect(mocks.privateTemp).toHaveBeenCalledWith('kudu-reg-restore-')
    expect(imp[1]).toEqual(['import', join(privateDirs[0]!, 'restore.reg')])
    expect(imported).toEqual(keysFile([RUN, DNS]))
    expect(mocks.tracked.mock.invocationCallOrder[0]).toBeLessThan(callOrder(exportCalls()[0]))
    expect(callOrder(exportCalls()[0])).toBeLessThan(callOrder(imp))
    // Exports are written into the private folder too.
    expect(exportCalls()[0][1][2].startsWith(privateDirs[0]!)).toBe(true)

    expect(preRestoreFiles()).toEqual([result.preRestoreBackup])
    const bytes = readFileSync(join(dir, result.preRestoreBackup!))
    // DNS did not exist, so undoing this restore must delete it again.
    expect(parseRegExport(bytes, true)).toMatchObject({ ok: true, keys: [RUN + '-now', DNS] })
    expect(parseRegExport(bytes, true)).toMatchObject({
      sections: [{ deleted: false }, { key: DNS, deleted: true }]
    })
    expect(result.keys).toEqual([RUN, DNS])
    // The existence check receives the keys as data, not as script text.
    const script = mocks.tracked.mock.calls[0][1].at(-1) as string
    expect(script).not.toContain('CurrentVersion')
    // Then the parents an import could create, stopping below the branch roots
    // (HKCU\SOFTWARE\Microsoft, HKLM\SOFTWARE\Policies).
    expect(probeItems(mocks.tracked.mock.calls[0][1])).toEqual([
      { k: RUN, n: ['Value'] },
      { k: DNS, n: ['Value'] },
      { k: 'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion', n: [] },
      { k: 'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows', n: [] },
      { k: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows NT', n: [] },
      { k: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft', n: [] }
    ])
  })

  it('deletes the highest parent the restore creates, never a scope or branch root', async () => {
    const product = 'HKEY_CURRENT_USER\\SOFTWARE\\Vendor\\Product'
    const service = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\NewSvc\\Parameters'
    const clsid = 'HKEY_CURRENT_USER\\SOFTWARE\\Classes\\CLSID\\{1234}\\InprocServer32'
    writeSealed(TARGETED, keysFile([product, product + '\\Sub', service, clsid]))
    // Vendor, NewSvc and {1234} are all missing; so are Classes\CLSID and the
    // Services root as far as this probe says — they must still never be deleted.
    baseline = []
    simulate({})

    const { preRestoreBackup } = await restoreRegistryBackup(TARGETED)

    const probed = mocks.tracked.mock.calls.flatMap((c) => probeItems(c[1]).map((i) => i.k))
    for (const root of [
      'HKEY_CURRENT_USER\\SOFTWARE',
      'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services',
      'HKEY_CURRENT_USER\\SOFTWARE\\Classes\\CLSID'
    ])
      expect(probed).not.toContain(root)
    const parsed = parseRegExport(readFileSync(join(dir, preRestoreBackup!)), true)
    expect(parsed).toMatchObject({
      ok: true,
      sections: [
        { key: 'HKEY_CURRENT_USER\\SOFTWARE\\Vendor', deleted: true },
        { key: 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\NewSvc', deleted: true },
        { key: 'HKEY_CURRENT_USER\\SOFTWARE\\Classes\\CLSID\\{1234}', deleted: true }
      ]
    })
    expect(parsed.ok && parsed.sections).toHaveLength(3)
  })

  it('stops at the first parent that already exists', async () => {
    const product = 'HKEY_CURRENT_USER\\SOFTWARE\\Vendor\\Suite\\Product'
    writeSealed(TARGETED, keysFile([product]))
    baseline = ['HKEY_CURRENT_USER\\SOFTWARE\\Vendor']
    simulate({})

    const { preRestoreBackup } = await restoreRegistryBackup(TARGETED)

    const text = readFileSync(join(dir, preRestoreBackup!)).toString('utf16le', 2)
    expect(text).toBe(`${HEADER}\r\n\r\n[-HKEY_CURRENT_USER\\SOFTWARE\\Vendor\\Suite]\r\n\r\n`)
  })

  it('seals the pre-restore backup it writes, so it can be restored in turn', async () => {
    writeSealed(TARGETED, keysFile([RUN, DNS]))
    simulate({ [RUN]: ['Value'] })

    const { preRestoreBackup } = await restoreRegistryBackup(TARGETED)

    const bytes = readFileSync(join(dir, preRestoreBackup!))
    expect(mocks.sealBackup).toHaveBeenCalledWith(dir, preRestoreBackup, bytes)
    expect(mocks.sealBackup.mock.invocationCallOrder[0]).toBeLessThan(callOrder(importCalls()[0]))
    const [listed] = (await listRegistryBackups()).filter((b) => b.name === preRestoreBackup)
    expect(listed).toMatchObject({ restorable: true, keys: [RUN + '-now', DNS] })
  })

  it('records values and keys absent before the restore as tombstones', async () => {
    const backup = regText([
      `[${RUN}]`,
      '@="default"',
      '"a\\"b\\\\c"="x"',
      '"Kept"="x"',
      '',
      `[${RUN}\\Added]`,
      '"v"="x"',
      '',
      `[${RUN}\\Added\\Deeper]`,
      ''
    ])
    writeSealed(TARGETED, backup)
    simulate({ [RUN]: ['kept', 'Unrelated'] })

    const { preRestoreBackup } = await restoreRegistryBackup(TARGETED)

    const text = readFileSync(join(dir, preRestoreBackup!)).toString('utf16le', 2)
    expect(text).toBe(
      `${HEADER}\r\n\r\n` +
        `[${RUN}-now]\r\n"Value"="data"\r\n\r\n` +
        `[-${RUN}\\Added]\r\n\r\n` +
        `[${RUN}]\r\n@=-\r\n"a\\"b\\\\c"=-\r\n\r\n`
    )
  })

  it('restores a sealed pre-restore backup, tombstones included', async () => {
    const snapshot = regText([`[${RUN}]`, '"Value"="old"', '', `[-${DNS}]`, ''])
    writeSealed(PRE, snapshot)
    simulate({ [RUN]: ['Value'], [DNS]: ['Value'] })

    const result = await restoreRegistryBackup(PRE)

    expect(imported).toEqual(snapshot)
    // Undoing the undo recreates DNS: it exists now, so it is exported.
    expect(exportCalls().map((c) => c[1][1])).toEqual([
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
      'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\DNSClient'
    ])
    expect(result.preRestoreBackup).not.toBe(PRE)
  })

  it.each([
    ['there is no seal', () => writeFileSync(join(dir, TARGETED), keysFile([RUN]))],
    [
      'the file changed after it was sealed',
      () => {
        writeSealed(TARGETED, keysFile([RUN]))
        writeFileSync(join(dir, TARGETED), keysFile([RUN + '\\Evil']))
      }
    ]
  ])('refuses to restore when %s, without running anything', async (_label, setup) => {
    setup()
    simulate({ [RUN]: ['Value'] })

    await expect(restoreRegistryBackup(TARGETED)).rejects.toThrow(/can't be verified/)
    expect(mocks.tracked).not.toHaveBeenCalled()
    expect(mocks.native).not.toHaveBeenCalled()
    expect(mocks.privateTemp).not.toHaveBeenCalled()
  })

  it('sweeps the seals of deleted backups before verifying', async () => {
    const gone = 'registry-backup-targeted-2026-09-14T04-54-02-325Z.reg'
    writeSealed(gone, keysFile([RUN]))
    rmSync(join(dir, gone))
    writeSealed(TARGETED, keysFile([RUN]))
    simulate({ [RUN]: ['Value'] })

    await restoreRegistryBackup(TARGETED)

    expect(mocks.removeSeal).toHaveBeenCalledWith(dir, gone.toLowerCase())
    expect(mocks.seals.has(gone.toLowerCase())).toBe(false)
  })

  it('writes the pre-restore backup before sealing it, and removes it if sealing fails', async () => {
    writeSealed(TARGETED, keysFile([RUN]))
    simulate({ [RUN]: ['Value'] })
    const existedWhenSealed: boolean[] = []
    mocks.sealBackup.mockImplementation(async (_d: string, name: string) => {
      existedWhenSealed.push(readdirSync(dir).includes(name))
      return false
    })

    await expect(restoreRegistryBackup(TARGETED)).rejects.toThrow(/seal/)
    expect(existedWhenSealed).toEqual([true])
    expect(preRestoreFiles()).toEqual([])
  })

  it('refuses a backup with HKEY_CLASSES_ROOT keys before running anything', async () => {
    writeSealed(TARGETED, keysFile([RUN, 'HKEY_CLASSES_ROOT\\CLSID\\{1234}']))
    await expect(restoreRegistryBackup(TARGETED)).rejects.toThrow(/HKEY_CLASSES_ROOT/)
    expect(mocks.tracked).not.toHaveBeenCalled()
    expect(mocks.native).not.toHaveBeenCalled()
  })

  it('refuses deletion lines in a sealed backup that is not a pre-restore backup', async () => {
    writeSealed(TARGETED, regText([`[${RUN}]`, '"Value"=-', '']))
    await expect(restoreRegistryBackup(TARGETED)).rejects.toThrow(/deletes registry data/)
    expect(mocks.native).not.toHaveBeenCalled()
  })

  it('keeps only the five newest pre-restore backups and drops the seals of the rest', async () => {
    const old = [1, 2, 3, 4, 5, 6].map((d) => `pre-restore-backup-2026-01-0${d}T00-00-00-000Z.reg`)
    for (const f of old) writeSealed(f, keysFile([RUN]))
    writeSealed(TARGETED, keysFile([RUN]))
    simulate({ [RUN]: ['Value'] })

    const { preRestoreBackup } = await restoreRegistryBackup(TARGETED)

    expect(preRestoreFiles().sort()).toEqual([...old.slice(2), preRestoreBackup].sort())
    expect(mocks.removeSeal.mock.calls.map((c) => c[1]).sort()).toEqual(old.slice(0, 2))
    expect([...mocks.seals.keys()].filter((k) => k.startsWith('pre-restore-')).sort()).toEqual(
      [...old.slice(2), preRestoreBackup!].map((f) => f.toLowerCase()).sort()
    )
  })

  it('never prunes the snapshot it just took, even when the clock went backwards', async () => {
    const future = [1, 2, 3, 4, 5].map((d) => `pre-restore-backup-2099-01-0${d}T00-00-00-000Z.reg`)
    for (const f of future) writeFileSync(join(dir, f), keysFile([RUN]))
    writeSealed(TARGETED, keysFile([RUN]))
    simulate({ [RUN]: ['Value'] })

    const { preRestoreBackup } = await restoreRegistryBackup(TARGETED)

    expect(preRestoreFiles()).toContain(preRestoreBackup)
    expect(preRestoreFiles()).toHaveLength(5)
  })

  it('aborts without importing when the pre-restore snapshot would not be restorable', async () => {
    writeSealed(TARGETED, keysFile([RUN]))
    simulate({ [RUN]: ['Value'] })
    // The key has grown since the backup: its export now exceeds the targeted key limit.
    mocks.native.mockImplementation(async (_tool: string, args: string[]) => {
      if (args[0] === 'export') {
        const many = Array.from({ length: 10_001 }, (_, i) => `${RUN}\\Sub${i}`)
        writeFileSync(args[2], keysFile([RUN, ...many]))
      }
      return { stdout: '', stderr: '' }
    })

    await expect(restoreRegistryBackup(TARGETED)).rejects.toThrow(/nothing was imported/)
    expect(importCalls()).toHaveLength(0)
    expect(preRestoreFiles()).toEqual([])
  })

  it('aborts without importing when the pre-restore snapshot cannot be sealed', async () => {
    writeSealed(TARGETED, keysFile([RUN]))
    simulate({ [RUN]: ['Value'] })
    mocks.sealBackup.mockResolvedValue(false)

    await expect(restoreRegistryBackup(TARGETED)).rejects.toThrow(/seal.*nothing was imported/)
    expect(importCalls()).toHaveLength(0)
    expect(preRestoreFiles()).toEqual([])
  })

  it('aborts without running anything when no private working folder can be made', async () => {
    writeSealed(TARGETED, keysFile([RUN]))
    simulate({ [RUN]: ['Value'] })
    mocks.privateTemp.mockRejectedValue(new Error('A private temp folder needs administrator'))

    await expect(restoreRegistryBackup(TARGETED)).rejects.toThrow(/nothing was imported/)
    expect(mocks.native).not.toHaveBeenCalled()
  })

  it('aborts without importing when a pre-restore export fails', async () => {
    writeSealed(TARGETED, keysFile([RUN, DNS]))
    simulate(
      { [RUN]: ['Value'], [DNS]: ['Value'] },
      'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\DNSClient'
    )

    await expect(restoreRegistryBackup(TARGETED)).rejects.toThrow(/nothing was imported/)
    expect(importCalls()).toHaveLength(0)
    expect(preRestoreFiles()).toEqual([])
  })

  it('aborts without exporting or importing when existence cannot be checked', async () => {
    writeSealed(TARGETED, keysFile([RUN]))
    mocks.tracked.mockRejectedValue(new Error('Requested registry access is not allowed.'))

    await expect(restoreRegistryBackup(TARGETED)).rejects.toThrow('not allowed')
    expect(mocks.native).not.toHaveBeenCalled()
  })

  it('records a tombstone-only pre-restore backup when none of the keys exist yet', async () => {
    writeSealed(TARGETED, keysFile([RUN, DNS]))
    simulate({})

    const { preRestoreBackup } = await restoreRegistryBackup(TARGETED)

    expect(exportCalls()).toHaveLength(0)
    expect(importCalls()).toHaveLength(1)
    expect(parseRegExport(readFileSync(join(dir, preRestoreBackup!)), true)).toMatchObject({
      ok: true,
      sections: [
        { key: RUN, deleted: true },
        { key: DNS, deleted: true }
      ]
    })
  })

  it('names the pre-restore backup when the import fails', async () => {
    writeSealed(TARGETED, keysFile([RUN, DNS]))
    simulate({ [RUN]: ['Value'] })
    mocks.native.mockImplementation(async (_tool: string, args: string[]) => {
      if (args[0] === 'import') throw new Error('ERROR: Error accessing the registry.')
      writeFileSync(args[2], keysFile([RUN]))
      return { stdout: '', stderr: '' }
    })

    await expect(restoreRegistryBackup(TARGETED)).rejects.toThrow(/saved to pre-restore-backup-/)
  })

  it.each([
    ['full-branch exports', 'registry-backup-HKCU-2026-09-20T04-54-02-325Z.reg', [RUN]],
    ['forbidden hives', TARGETED, [RUN, 'HKEY_LOCAL_MACHINE\\SAM\\SAM\\Domains']],
    ['deletion headers', TARGETED, [RUN, '-' + DNS]]
  ])('refuses %s before running anything', async (_label, name, keys) => {
    writeSealed(name, keysFile(keys))
    await expect(restoreRegistryBackup(name)).rejects.toThrow()
    expect(mocks.tracked).not.toHaveBeenCalled()
    expect(mocks.native).not.toHaveBeenCalled()
  })

  it('refuses every restore when not elevated, HKCU-only ones included, before any work', async () => {
    mocks.admin.mockReturnValue(false)
    const hkcuOnly = 'privacy-traces-backup-2026-09-20T04-54-02-325Z.reg'
    writeSealed(TARGETED, keysFile([RUN, DNS]))
    writeSealed(hkcuOnly, keysFile([RUN]))
    simulate({})
    for (const name of [TARGETED, hkcuOnly])
      await expect(restoreRegistryBackup(name)).rejects.toThrow(
        'Restoring a registry backup requires administrator privileges. Relaunch Kudu as administrator.'
      )
    expect(mocks.tracked).not.toHaveBeenCalled()
    expect(mocks.native).not.toHaveBeenCalled()
    expect(mocks.privateTemp).not.toHaveBeenCalled()
    expect(mocks.sealBackup).not.toHaveBeenCalled()

    mocks.admin.mockReturnValue(true)
    await expect(restoreRegistryBackup(hkcuOnly)).resolves.toMatchObject({ keys: [RUN] })
  })

  it('is unavailable off Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    await expect(restoreRegistryBackup(TARGETED)).rejects.toThrow(/only available on Windows/)
  })
})

describe('existence check batching', () => {
  const commandLines = () =>
    mocks.tracked.mock.calls.map((call) => (call[1] as string[]).join(' ').length)

  it('splits many keys across invocations that stay under the command-line limit', async () => {
    const keys = Array.from(
      { length: 3000 },
      (_, i) => [RUN, `Key${String(i).padStart(5, '0')}`].join(String.fromCharCode(92)) + 'Sub'
    )
    writeSealed(TARGETED, keysFile(keys))
    registry = {}
    mocks.tracked.mockImplementation(async (_tool: string, args: string[]) => answerProbe(args))
    mocks.native.mockResolvedValue({ stdout: '', stderr: '' })

    await restoreRegistryBackup(TARGETED)

    expect(mocks.tracked.mock.calls.length).toBeGreaterThan(1)
    for (const length of commandLines()) expect(length).toBeLessThan(32_767)
    const probed = mocks.tracked.mock.calls.flatMap((c) => probeItems(c[1]).map((i) => i.k))
    // Every section key, then the parents an import could create.
    expect(probed).toEqual([
      ...keys,
      RUN,
      'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion',
      'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows'
    ])
  })

  it('splits one key with many values across invocations and merges the answers', async () => {
    const names = Array.from({ length: 2000 }, (_, i) => `SomeLongishValueName${i}`)
    writeSealed(TARGETED, regText([`[${RUN}]`, ...names.map((n) => `"${n}"="x"`), '']))
    registry = { [RUN]: names }
    mocks.tracked.mockImplementation(async (_tool: string, args: string[]) => answerProbe(args))
    mocks.native.mockImplementation(async (_tool: string, args: string[]) => {
      if (args[0] === 'export') writeFileSync(args[2], keysFile([RUN]))
      return { stdout: '', stderr: '' }
    })

    const { preRestoreBackup } = await restoreRegistryBackup(TARGETED)

    expect(mocks.tracked.mock.calls.length).toBeGreaterThan(1)
    for (const length of commandLines()) expect(length).toBeLessThan(32_767)
    const items = mocks.tracked.mock.calls.flatMap((c) => probeItems(c[1]))
    expect(new Set(items.filter((i) => i.n.length).map((i) => i.k))).toEqual(new Set([RUN]))
    expect(items.filter((i) => i.k === RUN).length).toBeGreaterThan(1)
    expect(items.flatMap((i) => i.n)).toEqual(names)
    // Every value exists in some batch's answer, so none is tombstoned.
    const text = readFileSync(join(dir, preRestoreBackup!)).toString('utf16le', 2)
    expect(text).not.toContain('=-')
  })
})

/** Write a backup into the folder and seal it, as Kudu does when creating one. */
function writeSealed(name: string, buf: Buffer) {
  writeFileSync(join(dir, name), buf)
  seal(name)
}
