import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./settings-store', () => ({
  getSettings: () => ({ cleaner: { secureDelete: false }, exclusions: [] })
}))
vi.mock('./deletion-log-store', () => ({ recordDeletions: () => {} }))
const backupDir = vi.hoisted(() => ({ path: '' }))
vi.mock('./backup-dir', () => ({ getBackupDir: () => backupDir.path }))
const exec = vi.hoisted(() => vi.fn())
vi.mock('./exec-utf8', () => ({ execNativeUtf8: exec }))

import { cleanPrivacyTraces, scanPrivacyTraces, type PrivacyTrace } from './privacy-traces'
import {
  MRU_LISTS,
  clearMruList,
  findWindowsRecentTraces,
  findWindowsRegistryTraces,
  parseRegQuery,
  planMruClear,
  type MruList
} from './privacy-traces-windows'

const list = (leaf: string): MruList => MRU_LISTS.find((l) => l.key.endsWith('\\' + leaf))!
const RUN_MRU = list('RunMRU')
const RECENT_DOCS = list('RecentDocs')
const RDP = list('Default')
const HKCU_EXPLORER = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer'

const RUN_MRU_OUTPUT = [
  '',
  `${HKCU_EXPLORER}\\RunMRU`,
  '    (Default)    REG_SZ    (value not set)',
  '    a    REG_SZ    cmd\\1',
  '    b    REG_SZ    regedit\\1',
  '    c    REG_DWORD    0x1',
  '    MRUList    REG_SZ    ba',
  ''
].join('\r\n')

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kudu-win-traces-'))
  backupDir.path = join(root, 'Kudu Backups')
  exec.mockReset()
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Answer reg.exe calls: query returns `output`, export writes a backup unless told to fail. */
function fakeReg(output: string, opts: { exportFails?: boolean; exportEmpty?: boolean } = {}) {
  exec.mockImplementation(async (_tool: string, args: string[]) => {
    if (args[0] === 'query') return { stdout: output, stderr: '' }
    if (args[0] === 'export') {
      if (opts.exportFails) throw new Error('ERROR: Access is denied.')
      await writeFile(args[2], opts.exportEmpty ? '' : 'Windows Registry Editor Version 5.00')
      return { stdout: 'The operation completed successfully.', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}
const regCalls = () => exec.mock.calls.map((c) => c[1] as string[])

describe('parseRegQuery', () => {
  it('reads names and type tokens and normalises long hive names', () => {
    const listing = parseRegQuery(RUN_MRU_OUTPUT)
    const key = listing.get(`${RUN_MRU.key}`.toLowerCase())!
    expect(key.path).toBe(RUN_MRU.key)
    expect(key.values).toEqual([
      { name: '(Default)', type: 'REG_SZ' },
      { name: 'a', type: 'REG_SZ' },
      { name: 'b', type: 'REG_SZ' },
      { name: 'c', type: 'REG_DWORD' },
      { name: 'MRUList', type: 'REG_SZ' }
    ])
  })

  it('handles localised default labels, empty data and subkeys', () => {
    const output = [
      `${HKCU_EXPLORER}\\RecentDocs`,
      '    (Standard)    REG_SZ    (Wert nicht festgelegt)',
      '    0    REG_BINARY    4400',
      '    Leer    REG_SZ',
      '',
      `${HKCU_EXPLORER}\\RecentDocs\\.DOCX`,
      '    0    REG_BINARY    4400'
    ].join('\n')
    const listing = parseRegQuery(output)
    expect(listing.get(RECENT_DOCS.key.toLowerCase())!.values.map((v) => v.name)).toEqual([
      '(Standard)',
      '0',
      'Leer'
    ])
    expect(listing.get(`${RECENT_DOCS.key}\\.docx`.toLowerCase())!.path).toBe(
      `${RECENT_DOCS.key}\\.DOCX`
    )
  })
})

describe('planMruClear', () => {
  it('plans only typed entries, ordering value last, never the default value', () => {
    const plan = planMruClear(RUN_MRU, parseRegQuery(RUN_MRU_OUTPUT))
    expect(plan).toEqual({ entries: ['a', 'b'], subkeys: [], order: ['MRUList'], entryCount: 2 })
  })

  it('keeps a lone ordering value when the list has no entries', () => {
    const output = `${HKCU_EXPLORER}\\RunMRU\n    MRUList    REG_SZ    \n`
    const plan = planMruClear(RUN_MRU, parseRegQuery(output))
    expect(plan.entries).toEqual([])
    expect(plan.order).toEqual([])
  })

  it('removes only direct sub-lists which hold nothing but MRU values', () => {
    const output = [
      `${HKCU_EXPLORER}\\RecentDocs`,
      '    MRUListEx    REG_BINARY    01000000',
      '    0    REG_BINARY    4400',
      '    1    REG_BINARY    4400',
      `${HKCU_EXPLORER}\\RecentDocs\\.txt`,
      '    0    REG_BINARY    4400',
      '    MRUListEx    REG_BINARY    00000000',
      `${HKCU_EXPLORER}\\RecentDocs\\Folder`,
      '    Setting    REG_DWORD    0x1',
      `${HKCU_EXPLORER}\\RecentDocs\\Nested`,
      '    0    REG_BINARY    4400',
      `${HKCU_EXPLORER}\\RecentDocs\\Nested\\Child`,
      '    0    REG_BINARY    4400'
    ].join('\n')
    const plan = planMruClear(RECENT_DOCS, parseRegQuery(output))
    expect(plan).toEqual({
      entries: ['0', '1'],
      subkeys: [`${RECENT_DOCS.key}\\.txt`],
      order: ['MRUListEx'],
      entryCount: 2
    })
  })

  it('never plans subkeys for the Remote Desktop list', () => {
    const output = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Terminal Server Client\\Default',
      '    MRU0    REG_SZ    server.example',
      '    MRU1    REG_SZ    10.0.0.4',
      '    MRU10    REG_SZ    not-an-rdp-entry',
      '    UsernameHint    REG_SZ    alice',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Terminal Server Client\\Default\\AddIns',
      '    MRU0    REG_SZ    x'
    ].join('\n')
    expect(planMruClear(RDP, parseRegQuery(output))).toEqual({
      entries: ['MRU0', 'MRU1'],
      subkeys: [],
      order: [],
      entryCount: 2
    })
  })
})

describe('clearMruList', () => {
  it('backs up before deleting, and deletes values only', async () => {
    fakeReg(RUN_MRU_OUTPUT)
    await clearMruList(RUN_MRU)
    const calls = regCalls()
    expect(calls.map((c) => c[0])).toEqual(['query', 'export', 'delete', 'delete', 'delete'])
    expect(calls[1][1]).toBe(RUN_MRU.key)
    expect(calls.slice(2)).toEqual([
      ['delete', RUN_MRU.key, '/v', 'a', '/f'],
      ['delete', RUN_MRU.key, '/v', 'b', '/f'],
      ['delete', RUN_MRU.key, '/v', 'MRUList', '/f']
    ])
    const backups = await readdir(backupDir.path)
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(/^privacy-traces-backup-RunMRU-.*\.reg$/)
  })

  it('removes sub-lists but never the list key itself', async () => {
    fakeReg(
      [
        `${HKCU_EXPLORER}\\ComDlg32\\OpenSavePidlMRU`,
        `${HKCU_EXPLORER}\\ComDlg32\\OpenSavePidlMRU\\*`,
        '    0    REG_BINARY    14001F',
        '    MRUListEx    REG_BINARY    00000000'
      ].join('\n')
    )
    const openSave = list('OpenSavePidlMRU')
    await clearMruList(openSave)
    const deletes = regCalls().filter((c) => c[0] === 'delete')
    expect(deletes).toEqual([['delete', `${openSave.key}\\*`, '/f']])
    expect(deletes.some((c) => c[1] === openSave.key && !c.includes('/v'))).toBe(false)
  })

  it('aborts without deleting anything when the backup fails', async () => {
    fakeReg(RUN_MRU_OUTPUT, { exportFails: true })
    await expect(clearMruList(RUN_MRU)).rejects.toMatchObject({
      reason: 'registry backup failed, nothing was changed'
    })
    expect(regCalls().some((c) => c[0] === 'delete')).toBe(false)
  })

  it('aborts when the backup file is empty, and removes the empty file', async () => {
    fakeReg(RUN_MRU_OUTPUT, { exportEmpty: true })
    await expect(clearMruList(RUN_MRU)).rejects.toBeDefined()
    expect(regCalls().some((c) => c[0] === 'delete')).toBe(false)
    const left = await readdir(backupDir.path).catch(() => [] as string[])
    expect(left.filter((f) => f.startsWith('privacy-traces-backup-'))).toEqual([])
  })

  it('does nothing, not even a backup, when the list is already empty', async () => {
    fakeReg(`${HKCU_EXPLORER}\\RunMRU\n`)
    await clearMruList(RUN_MRU)
    expect(regCalls().map((c) => c[0])).toEqual(['query'])
  })

  it('keeps only the newest backups of a list', async () => {
    await mkdir(backupDir.path, { recursive: true })
    for (const ts of ['2020-01-01', '2020-01-02', '2020-01-03', '2020-01-04']) {
      await writeFile(join(backupDir.path, `privacy-traces-backup-RunMRU-${ts}.reg`), 'x')
    }
    await writeFile(join(backupDir.path, 'registry-backup-2020-01-01.reg'), 'x')
    fakeReg(RUN_MRU_OUTPUT)
    await clearMruList(RUN_MRU)
    const files = await readdir(backupDir.path)
    expect(files.filter((f) => f.startsWith('privacy-traces-backup-RunMRU-'))).toHaveLength(3)
    expect(files).toContain('registry-backup-2020-01-01.reg')
  })
})

describe('findWindowsRegistryTraces', () => {
  it('reports one unselected item per non-empty list with its entry count', async () => {
    exec.mockImplementation(async (_tool: string, args: string[]) => {
      if (args[0] === 'query' && args[1] === RUN_MRU.key) return { stdout: RUN_MRU_OUTPUT }
      throw new Error('ERROR: The system was unable to find the specified registry key or value.')
    })
    const results = await scanPrivacyTraces(
      [findWindowsRegistryTraces],
      { platform: 'win32', home: root, env: {}, exclusions: [] },
      new Map()
    )
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      subcategory: 'Run dialog history',
      descriptionKey: 'privacyRegistryListNote'
    })
    expect(results[0].items[0]).toMatchObject({
      path: RUN_MRU.key,
      entryCount: 2,
      size: 0,
      selected: false
    })
  })

  it('does nothing off Windows', async () => {
    expect(
      await findWindowsRegistryTraces({ platform: 'linux', home: root, env: {}, exclusions: [] })
    ).toEqual([])
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('findWindowsRecentTraces', () => {
  it('lists top-level shortcuts only and never touches jump lists', async () => {
    const appData = join(root, 'Roaming')
    const recent = join(appData, 'Microsoft', 'Windows', 'Recent')
    const office = join(appData, 'Microsoft', 'Office', 'Recent')
    const jumpList = join(
      recent,
      'AutomaticDestinations',
      'f01b4d95cf55d32a.automaticDestinations-ms'
    )
    const custom = join(recent, 'CustomDestinations', 'pinned.lnk')
    await mkdir(join(recent, 'AutomaticDestinations'), { recursive: true })
    await mkdir(join(recent, 'CustomDestinations'), { recursive: true })
    await mkdir(office, { recursive: true })
    await writeFile(jumpList, 'pinned')
    await writeFile(custom, 'pinned')
    await writeFile(join(recent, 'report.docx.lnk'), 'lnk')
    await writeFile(join(recent, 'desktop.ini'), 'ini')
    await writeFile(join(office, 'budget.xlsx.LNK'), 'lnk')
    await writeFile(join(office, 'index.dat'), 'dat')

    const cache = new Map<string, PrivacyTrace>()
    const results = await scanPrivacyTraces(
      [findWindowsRecentTraces],
      { platform: 'win32', home: root, env: { APPDATA: appData }, exclusions: [] },
      cache
    )
    expect(results.map((r) => [r.subcategory, r.items.map((i) => i.path)])).toEqual([
      ['Recent items', [join(recent, 'report.docx.lnk')]],
      ['Office recent files', [join(office, 'budget.xlsx.LNK')]]
    ])

    const ids = results.flatMap((r) => r.items.map((i) => i.id))
    const outcome = await cleanPrivacyTraces(ids, cache, { secureDelete: false, exclusions: [] })
    expect(outcome.filesDeleted).toBe(2)
    expect(existsSync(join(recent, 'report.docx.lnk'))).toBe(false)
    expect(existsSync(jumpList)).toBe(true)
    expect(existsSync(custom)).toBe(true)
    expect(existsSync(join(recent, 'desktop.ini'))).toBe(true)
    expect(existsSync(join(office, 'index.dat'))).toBe(true)
  })

  it('does nothing off Windows', async () => {
    expect(
      await findWindowsRecentTraces({ platform: 'darwin', home: root, env: {}, exclusions: [] })
    ).toEqual([])
  })
})
