import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DeletedFileRecord } from '../../shared/types'

let testDir: string

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => testDir,
  },
}))

import {
  recordDeletions,
  queryDeletions,
  queryAllDeletions,
  clearDeletionLog,
  getDeletionLogPath,
  MAX_QUERY_LIMIT,
  _resetDeletionLogPathCache,
} from './deletion-log-store'

const rec = (ts: string, path: string, size = 100, category = 'Temp'): DeletedFileRecord =>
  ({ ts, path, size, category })

describe('deletion-log-store', () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'kudu-dellog-test-'))
    _resetDeletionLogPathCache()
  })

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('returns nothing when no log exists', () => {
    expect(queryDeletions()).toEqual({ records: [], total: 0 })
  })

  it('writes nothing for an empty batch', () => {
    recordDeletions([])
    expect(existsSync(getDeletionLogPath())).toBe(false)
  })

  it('persists records and reads them back newest first', () => {
    recordDeletions([
      rec('2026-07-20T10:00:00.000Z', 'C:\\a.tmp'),
      rec('2026-07-20T10:00:01.000Z', 'C:\\b.tmp'),
    ])
    const { records, total } = queryDeletions()
    expect(total).toBe(2)
    expect(records.map((r) => r.path)).toEqual(['C:\\b.tmp', 'C:\\a.tmp'])
  })

  it('appends across separate calls rather than overwriting', () => {
    recordDeletions([rec('2026-07-20T10:00:00.000Z', 'C:\\a.tmp')])
    recordDeletions([rec('2026-07-20T10:00:01.000Z', 'C:\\b.tmp')])
    expect(queryDeletions().total).toBe(2)
  })

  it('filters to an inclusive time window', () => {
    recordDeletions([
      rec('2026-07-20T09:59:59.000Z', 'C:\\before.tmp'),
      rec('2026-07-20T10:00:00.000Z', 'C:\\start.tmp'),
      rec('2026-07-20T10:00:30.000Z', 'C:\\middle.tmp'),
      rec('2026-07-20T10:01:00.000Z', 'C:\\end.tmp'),
      rec('2026-07-20T10:01:01.000Z', 'C:\\after.tmp'),
    ])
    const { records, total } = queryDeletions({
      from: '2026-07-20T10:00:00.000Z',
      to: '2026-07-20T10:01:00.000Z',
    })
    expect(total).toBe(3)
    expect(records.map((r) => r.path)).toEqual(['C:\\end.tmp', 'C:\\middle.tmp', 'C:\\start.tmp'])
  })

  it('pages through a window with offset and limit', () => {
    recordDeletions(
      Array.from({ length: 10 }, (_, i) =>
        rec(`2026-07-20T10:00:0${i}.000Z`, `C:\\file-${i}.tmp`)
      )
    )
    const first = queryDeletions({ offset: 0, limit: 4 })
    expect(first.total).toBe(10)
    expect(first.records).toHaveLength(4)
    expect(first.records[0].path).toBe('C:\\file-9.tmp')

    const second = queryDeletions({ offset: 4, limit: 4 })
    expect(second.records[0].path).toBe('C:\\file-5.tmp')

    const last = queryDeletions({ offset: 8, limit: 4 })
    expect(last.records).toHaveLength(2)
  })

  it('caps limit at MAX_QUERY_LIMIT and floors it at 1', () => {
    recordDeletions(
      Array.from({ length: 5 }, (_, i) => rec(`2026-07-20T10:00:0${i}.000Z`, `C:\\f${i}`))
    )
    expect(queryDeletions({ limit: 10_000 }).records).toHaveLength(5)
    expect(queryDeletions({ limit: 0 }).records).toHaveLength(1)
    expect(queryDeletions({ limit: -5 }).records).toHaveLength(1)
    expect(MAX_QUERY_LIMIT).toBeGreaterThan(0)
  })

  it('skips corrupt lines instead of losing the whole log', () => {
    recordDeletions([rec('2026-07-20T10:00:00.000Z', 'C:\\good-1.tmp')])
    appendFileSync(getDeletionLogPath(), '{not json\n', 'utf-8')
    appendFileSync(getDeletionLogPath(), '{"ts":"2026-07-20T10:00:02.000Z"}\n', 'utf-8') // no path
    recordDeletions([rec('2026-07-20T10:00:03.000Z', 'C:\\good-2.tmp')])

    const { records, total } = queryDeletions()
    expect(total).toBe(2)
    expect(records.map((r) => r.path)).toEqual(['C:\\good-2.tmp', 'C:\\good-1.tmp'])
  })

  it('defaults missing size and category on partial records', () => {
    writeFileSync(
      getDeletionLogPath(),
      JSON.stringify({ ts: '2026-07-20T10:00:00.000Z', path: 'C:\\x.tmp' }) + '\n',
      'utf-8'
    )
    const { records } = queryDeletions()
    expect(records[0]).toEqual({
      ts: '2026-07-20T10:00:00.000Z', path: 'C:\\x.tmp', size: 0, category: '', origin: 'local'
    })
  })

  it('excludes records with an unparseable timestamp from a windowed query', () => {
    writeFileSync(
      getDeletionLogPath(),
      JSON.stringify({ ts: 'not-a-date', path: 'C:\\x.tmp', size: 1, category: 'Temp' }) + '\n',
      'utf-8'
    )
    expect(queryDeletions({ from: '2026-07-20T00:00:00.000Z' }).total).toBe(0)
    // Without a window there is nothing to compare against, so it still lists.
    expect(queryDeletions().total).toBe(1)
  })

  it('rotates past the size cap and still reads both files in order', () => {
    // One oversized record pushes the log past the 8 MB rotation threshold.
    recordDeletions([rec('2026-07-20T10:00:00.000Z', 'C:\\old.tmp' + 'x'.repeat(9 * 1024 * 1024))])
    recordDeletions([rec('2026-07-20T10:00:01.000Z', 'C:\\new.tmp')])

    expect(existsSync(join(testDir, 'deleted-files.old.jsonl'))).toBe(true)
    const { records, total } = queryDeletions()
    expect(total).toBe(2)
    expect(records[0].path).toBe('C:\\new.tmp')
    // The live log holds only what was written after rotation.
    expect(readFileSync(getDeletionLogPath(), 'utf-8').trim().split('\n')).toHaveLength(1)
  })

  it('queryAllDeletions returns every match in the window, unpaged', () => {
    recordDeletions(
      Array.from({ length: 250 }, (_, i) =>
        rec(new Date(Date.UTC(2026, 6, 20, 10, 0, i)).toISOString(), `C:\\f${i}`)
      )
    )
    expect(queryAllDeletions()).toHaveLength(250)
    expect(queryAllDeletions({ from: new Date(Date.UTC(2026, 6, 20, 10, 0, 200)).toISOString() })).toHaveLength(50)
  })

  it('filters by origin so overlapping runs stay separable', () => {
    recordDeletions([
      { ...rec('2026-07-20T10:00:00.000Z', 'C:\\manual.tmp'), origin: 'local' },
      { ...rec('2026-07-20T10:00:01.000Z', 'C:\\remote.tmp'), origin: 'cloud' },
      { ...rec('2026-07-20T10:00:02.000Z', 'C:\\terminal.tmp'), origin: 'cli' },
    ])

    const window = { from: '2026-07-20T10:00:00.000Z', to: '2026-07-20T10:00:02.000Z' }
    expect(queryDeletions(window).total).toBe(3)
    expect(queryDeletions({ ...window, origin: 'local' }).records.map((r) => r.path)).toEqual(['C:\\manual.tmp'])
    expect(queryDeletions({ ...window, origin: 'cloud' }).records.map((r) => r.path)).toEqual(['C:\\remote.tmp'])
    expect(queryDeletions({ ...window, origin: 'cli' }).records.map((r) => r.path)).toEqual(['C:\\terminal.tmp'])
  })

  it('treats records written before origin tracking as local', () => {
    writeFileSync(
      getDeletionLogPath(),
      JSON.stringify({ ts: '2026-07-20T10:00:00.000Z', path: 'C:\\legacy.tmp', size: 1, category: 'Temp' }) + '\n',
      'utf-8'
    )
    expect(queryDeletions({ origin: 'local' }).total).toBe(1)
    expect(queryDeletions({ origin: 'cloud' }).total).toBe(0)
  })

  it('round-trips a truncation count and ignores a meaningless one', () => {
    recordDeletions([
      { ...rec('2026-07-20T10:00:00.000Z', 'C:\\big-folder'), truncated: 1200 },
      { ...rec('2026-07-20T10:00:01.000Z', 'C:\\small-folder'), truncated: 0 },
    ])
    const { records } = queryDeletions()
    expect(records.find((r) => r.path === 'C:\\big-folder')?.truncated).toBe(1200)
    expect(records.find((r) => r.path === 'C:\\small-folder')?.truncated).toBeUndefined()
  })

  it('clear empties the live log and drops the rotated one', () => {
    recordDeletions([rec('2026-07-20T10:00:00.000Z', 'C:\\old.tmp' + 'x'.repeat(9 * 1024 * 1024))])
    recordDeletions([rec('2026-07-20T10:00:01.000Z', 'C:\\new.tmp')])
    expect(queryDeletions().total).toBe(2)

    clearDeletionLog()

    expect(queryDeletions()).toEqual({ records: [], total: 0 })
    expect(existsSync(join(testDir, 'deleted-files.old.jsonl'))).toBe(false)
  })

  it('never throws when the data directory cannot be written', () => {
    // Point the store at a path that can't be a directory (an existing file).
    const filePath = join(testDir, 'blocker')
    writeFileSync(filePath, 'x', 'utf-8')
    testDir = join(filePath, 'nested')
    _resetDeletionLogPathCache()

    expect(() => recordDeletions([rec('2026-07-20T10:00:00.000Z', 'C:\\a.tmp')])).not.toThrow()
    expect(() => clearDeletionLog()).not.toThrow()
    expect(queryDeletions()).toEqual({ records: [], total: 0 })

    testDir = filePath // restore something removable for afterEach
  })
})
