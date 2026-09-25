import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pruneOrphanedTrashInfo, trashEntryNames } from './trash-info'

let trash: string
const files = () => join(trash, 'files')
const info = (name: string) => join(trash, 'info', `${name}.trashinfo`)

function trashed(name: string, { payload = true, ageMs = 10 * 60_000 } = {}) {
  if (payload) writeFileSync(join(files(), name), 'x')
  writeFileSync(info(name), '[Trash Info]\nPath=/home/u/secret/' + name + '\n')
  const t = (Date.now() - ageMs) / 1000
  utimesSync(info(name), t, t)
}

beforeEach(() => {
  trash = join(mkdtempSync(join(tmpdir(), 'kudu-trash-')), 'Trash')
  mkdirSync(files(), { recursive: true })
  mkdirSync(join(trash, 'info'), { recursive: true })
})
afterEach(() => rmSync(join(trash, '..'), { recursive: true, force: true }))

describe('pruneOrphanedTrashInfo', () => {
  it('removes records whose trashed item is gone', async () => {
    trashed('report.pdf', { payload: false })
    expect(await pruneOrphanedTrashInfo(files())).toBe(1)
    expect(existsSync(info('report.pdf'))).toBe(false)
  })

  it('keeps records for items still in the trash', async () => {
    trashed('photo.jpg')
    expect(await pruneOrphanedTrashInfo(files())).toBe(0)
    expect(existsSync(info('photo.jpg'))).toBe(true)
  })

  it('keeps a fresh orphan, which may be a trash operation in flight', async () => {
    trashed('moving.iso', { payload: false, ageMs: 5_000 })
    expect(await pruneOrphanedTrashInfo(files())).toBe(0)
    expect(existsSync(info('moving.iso'))).toBe(true)
  })

  it('ignores files in info/ that are not trash records', async () => {
    writeFileSync(join(trash, 'info', 'notes.txt'), 'x')
    writeFileSync(join(trash, 'info', '.trashinfo'), 'x')
    expect(await pruneOrphanedTrashInfo(files())).toBe(0)
    expect(existsSync(join(trash, 'info', 'notes.txt'))).toBe(true)
  })

  it('does nothing for trash folders outside the freedesktop layout', async () => {
    trashed('old.txt', { payload: false })
    expect(await pruneOrphanedTrashInfo(join(trash, '..', '.Trash'))).toBe(0)
    expect(existsSync(info('old.txt'))).toBe(true)
  })

  it('does nothing when there is no info folder', async () => {
    rmSync(join(trash, 'info'), { recursive: true })
    expect(await pruneOrphanedTrashInfo(files())).toBe(0)
  })
})

describe('pruneOrphanedTrashInfo for entries Kudu just cleaned', () => {
  it('removes a fresh record when its entry was just cleaned', async () => {
    // Emptied within the grace period: nothing would ever prune it later.
    trashed('just-trashed.txt', { payload: false, ageMs: 5_000 })
    expect(await pruneOrphanedTrashInfo(files(), new Set(['just-trashed.txt']))).toBe(1)
    expect(existsSync(info('just-trashed.txt'))).toBe(false)
  })

  it('still keeps the record if the cleaned entry survived', async () => {
    trashed('locked.bin', { ageMs: 5_000 })
    expect(await pruneOrphanedTrashInfo(files(), new Set(['locked.bin']))).toBe(0)
    expect(existsSync(info('locked.bin'))).toBe(true)
  })

  it('keeps other fresh orphans that were not part of the clean', async () => {
    trashed('in-flight.iso', { payload: false, ageMs: 5_000 })
    expect(await pruneOrphanedTrashInfo(files(), new Set(['something-else']))).toBe(0)
    expect(existsSync(info('in-flight.iso'))).toBe(true)
  })
})

describe('trashEntryNames', () => {
  it('maps cleaned paths to their top-level trash entry', () => {
    const names = trashEntryNames(files(), [
      join(files(), 'report.pdf'),
      join(files(), 'Project', 'src', 'main.c'),
      join(files(), 'Project', 'README')
    ])
    expect([...names].sort()).toEqual(['Project', 'report.pdf'])
  })

  it('ignores paths outside the trash', () => {
    expect(trashEntryNames(files(), [join(trash, 'info', 'x.trashinfo'), files()]).size).toBe(0)
  })
})
