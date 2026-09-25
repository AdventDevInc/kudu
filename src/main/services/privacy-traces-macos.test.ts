import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./settings-store', () => ({
  getSettings: () => ({ cleaner: { secureDelete: false }, exclusions: [] })
}))
vi.mock('./deletion-log-store', () => ({ recordDeletions: () => {} }))
const execFile = vi.hoisted(() => vi.fn())
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile
}))

import {
  cleanPrivacyTraces,
  scanPrivacyTraces,
  statTraceFile,
  type PrivacyTrace,
  type TraceScanContext
} from './privacy-traces'
import {
  clearQuarantineEvents,
  existingDatabaseUri,
  findMacQuarantineTraces,
  findMacRecentItemTraces,
  sqliteFailureReason
} from './privacy-traces-macos'

type Callback = (err: Error | null, stdout: string, stderr: string) => void

/** Answer sqlite3 calls: `onCall` returns stdout or throws an error carrying stderr. */
function fakeSqlite(onCall: (args: string[]) => string) {
  execFile.mockImplementation((_file: string, args: string[], _opts: unknown, cb: Callback) => {
    try {
      cb(null, onCall(args), '')
    } catch (err) {
      cb(err as Error, '', (err as { stderr?: string }).stderr ?? '')
    }
  })
}
const sqliteError = (stderr: string) => Object.assign(new Error('Command failed'), { stderr })

let home: string
const ctx = (): TraceScanContext => ({ platform: 'darwin', home, env: {}, exclusions: [] })
const sharedFileList = () =>
  join(home, 'Library', 'Application Support', 'com.apple.sharedfilelist')
const quarantineDb = () =>
  join(home, 'Library', 'Preferences', 'com.apple.LaunchServices.QuarantineEventsV2')

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kudu-mac-traces-'))
  execFile.mockReset()
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('findMacRecentItemTraces', () => {
  it('lists Recent* lists and per-app lists, never sidebar favourites', async () => {
    const dir = sharedFileList()
    const perApp = join(dir, 'com.apple.LSSharedFileList.ApplicationRecentDocuments')
    await mkdir(perApp, { recursive: true })
    const recent = [
      'com.apple.LSSharedFileList.RecentDocuments.sfl3',
      'com.apple.LSSharedFileList.RecentApplications.sfl2',
      'com.apple.LSSharedFileList.RecentServers.sfl3',
      'com.apple.LSSharedFileList.RecentHosts.sfl2'
    ]
    const kept = [
      'com.apple.LSSharedFileList.FavoriteItems.sfl3',
      'com.apple.LSSharedFileList.FavoriteVolumes.sfl3',
      'com.apple.LSSharedFileList.ProjectsItems.sfl3',
      'com.apple.LSSharedFileList.RecentDocuments.sfl3.backup'
    ]
    for (const name of [...recent, ...kept]) await writeFile(join(dir, name), 'list')
    await writeFile(join(perApp, 'com.apple.textedit.sfl3'), 'list')
    await writeFile(join(perApp, 'notes.txt'), 'x')

    const cache = new Map<string, PrivacyTrace>()
    const results = await scanPrivacyTraces([findMacRecentItemTraces], ctx(), cache)
    expect(results.map((r) => r.subcategory)).toEqual(['Recent items', 'App recent documents'])
    expect(results[0].items.map((i) => i.path).sort()).toEqual(
      recent.map((n) => join(dir, n)).sort()
    )
    expect(results[1].items.map((i) => i.path)).toEqual([join(perApp, 'com.apple.textedit.sfl3')])
    expect(results.flatMap((r) => r.items).every((i) => i.selected === false)).toBe(true)

    const ids = results.flatMap((r) => r.items.map((i) => i.id))
    const outcome = await cleanPrivacyTraces(ids, cache, { secureDelete: false, exclusions: [] })
    expect(outcome.filesDeleted).toBe(5)
    for (const name of recent) expect(existsSync(join(dir, name))).toBe(false)
    for (const name of kept) expect(existsSync(join(dir, name))).toBe(true)
  })

  it('skips symlinked lists', async () => {
    const dir = sharedFileList()
    await mkdir(dir, { recursive: true })
    const elsewhere = join(home, 'elsewhere.sfl3')
    await writeFile(elsewhere, 'x')
    try {
      await symlink(elsewhere, join(dir, 'com.apple.LSSharedFileList.RecentDocuments.sfl3'))
    } catch {
      return // symlinks unavailable (Windows without Developer Mode)
    }
    expect(await findMacRecentItemTraces(ctx())).toEqual([])
  })

  it('does nothing on other platforms', async () => {
    await mkdir(sharedFileList(), { recursive: true })
    await writeFile(
      join(sharedFileList(), 'com.apple.LSSharedFileList.RecentDocuments.sfl3'),
      'list'
    )
    expect(await findMacRecentItemTraces({ ...ctx(), platform: 'linux' })).toEqual([])
  })
})

describe('Quarantine Events download history', () => {
  async function createDb() {
    await mkdir(join(home, 'Library', 'Preferences'), { recursive: true })
    await writeFile(quarantineDb(), 'SQLite format 3\u0000')
  }

  it('reports the row count read-only and clears rows without deleting the file', async () => {
    await createDb()
    const calls: string[][] = []
    fakeSqlite((args) => {
      calls.push(args)
      return args.includes('-readonly') ? '42\n' : ''
    })
    const cache = new Map<string, PrivacyTrace>()
    const [result] = await scanPrivacyTraces([findMacQuarantineTraces], ctx(), cache)
    expect(result.subcategory).toBe('Download history')
    expect(result.items[0]).toMatchObject({ entryCount: 42, size: 0, selected: false })
    expect(calls[0]).toEqual([
      '-readonly',
      '-cmd',
      '.timeout 2000',
      quarantineDb(),
      'SELECT COUNT(*) FROM LSQuarantineEvent;'
    ])

    const outcome = await cleanPrivacyTraces([result.items[0].id], cache, {
      secureDelete: false,
      exclusions: []
    })
    expect(outcome.filesDeleted).toBe(1)
    expect(calls[1]).toEqual([
      '-bail',
      '-cmd',
      '.timeout 2000',
      existingDatabaseUri(quarantineDb()),
      'PRAGMA secure_delete = ON; DELETE FROM LSQuarantineEvent;'
    ])
    expect(existsSync(quarantineDb())).toBe(true)
  })

  it('reports nothing for an empty, missing or unreadable database', async () => {
    fakeSqlite(() => '0\n')
    expect(await findMacQuarantineTraces(ctx())).toEqual([])
    await createDb()
    expect(await findMacQuarantineTraces(ctx())).toEqual([])
    fakeSqlite(() => {
      throw sqliteError('Error: unable to open database file')
    })
    expect(await findMacQuarantineTraces(ctx())).toEqual([])
  })

  it('reports a locked database as skipped', async () => {
    await createDb()
    fakeSqlite(() => {
      throw sqliteError('Error: stepping, database is locked (5)')
    })
    const info = (await statTraceFile(quarantineDb()))!
    await expect(clearQuarantineEvents(quarantineDb(), info)).rejects.toMatchObject({
      reason: 'in-use'
    })
  })

  it('refuses a database replaced since the scan', async () => {
    await createDb()
    const info = (await statTraceFile(quarantineDb()))!
    await rm(quarantineDb())
    await createDb()
    fakeSqlite(() => '')
    await expect(clearQuarantineEvents(quarantineDb(), info)).rejects.toBeDefined()
    expect(execFile).not.toHaveBeenCalled()
  })

  it('maps sqlite3 errors to skip reasons', () => {
    expect(sqliteFailureReason(sqliteError('Error: database is locked'))).toBe('in-use')
    expect(sqliteFailureReason(sqliteError('attempt to write a readonly database'))).toBe(
      'permission-denied'
    )
    expect(sqliteFailureReason(sqliteError('Error: no such table: LSQuarantineEvent'))).toBe(
      'not-found'
    )
  })

  it('encodes the database path so it can never be created', () => {
    expect(existingDatabaseUri('/Users/Jane Doe/Library/x#y')).toBe(
      'file:/Users/Jane%20Doe/Library/x%23y?mode=rw'
    )
  })
})
