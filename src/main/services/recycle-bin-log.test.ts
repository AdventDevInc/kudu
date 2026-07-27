import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'

const state = vi.hoisted(() => ({
  keepDeletionLog: false,
  settingsThrows: false,
  /** stdout for each successive bin enumeration */
  enumerations: [] as string[],
  recorded: [] as any[],
}))

vi.mock('child_process', () => ({
  execFile: (_file: string, _args: string[], _opts: unknown, cb: (e: unknown, r?: unknown) => void) => {
    cb(null, { stdout: state.enumerations.shift() ?? '[]' })
  },
}))

vi.mock('./exec-utf8', () => ({ psUtf8: (s: string) => s }))

vi.mock('./settings-store', () => ({
  getSettings: () => {
    if (state.settingsThrows) throw new Error('no app')
    return { cleaner: { keepDeletionLog: state.keepDeletionLog } }
  },
}))

vi.mock('./deletion-log-store', () => ({
  recordDeletions: (records: unknown[]) => { state.recorded.push(...records) },
}))

import {
  isDeletionLoggingEnabled,
  listRecycleBinContents,
  recordEmptiedRecycleBin,
} from './recycle-bin-log'

const binItems = (items: Array<{ name: string; origin?: string; size?: number }>) =>
  JSON.stringify(items.map((i) => ({ name: i.name, origin: i.origin ?? '', size: i.size ?? 0 })))

describe('recycle-bin-log', () => {
  beforeEach(() => {
    state.keepDeletionLog = false
    state.settingsThrows = false
    state.enumerations = []
    state.recorded = []
  })

  describe('isDeletionLoggingEnabled', () => {
    it('reflects the setting', () => {
      expect(isDeletionLoggingEnabled()).toBe(false)
      state.keepDeletionLog = true
      expect(isDeletionLoggingEnabled()).toBe(true)
    })

    it('reports disabled rather than throwing when settings are unavailable', () => {
      state.settingsThrows = true
      expect(isDeletionLoggingEnabled()).toBe(false)
    })
  })

  describe('listRecycleBinContents', () => {
    it('joins each item onto its original location', async () => {
      state.enumerations = [binItems([
        { name: 'notes.txt', origin: 'C:\\Users\\dave\\Documents', size: 120 },
        { name: 'photo.png', origin: 'D:\\Pictures', size: 4096 },
      ])]

      expect(await listRecycleBinContents()).toEqual([
        { path: join('C:\\Users\\dave\\Documents', 'notes.txt'), size: 120 },
        { path: join('D:\\Pictures', 'photo.png'), size: 4096 },
      ])
    })

    it('falls back to the bare name when Windows reports no original location', async () => {
      state.enumerations = [binItems([{ name: 'orphan.dat', size: 8 }])]
      expect(await listRecycleBinContents()).toEqual([{ path: 'orphan.dat', size: 8 }])
    })

    it('accepts a lone object, which is what ConvertTo-Json can emit', async () => {
      state.enumerations = [JSON.stringify({ name: 'solo.txt', origin: 'C:\\a', size: 1 })]
      expect(await listRecycleBinContents()).toEqual([{ path: join('C:\\a', 'solo.txt'), size: 1 }])
    })

    it('returns nothing for empty, malformed or nameless output', async () => {
      state.enumerations = ['']
      expect(await listRecycleBinContents()).toEqual([])
      state.enumerations = ['not json']
      expect(await listRecycleBinContents()).toEqual([])
      state.enumerations = [JSON.stringify([{ origin: 'C:\\a', size: 1 }])]
      expect(await listRecycleBinContents()).toEqual([])
    })
  })

  describe('recordEmptiedRecycleBin', () => {
    it('records everything when the bin came back empty', async () => {
      state.enumerations = ['[]'] // post-empty re-read
      await recordEmptiedRecycleBin(
        [{ path: 'C:\\a\\one.txt', size: 1 }, { path: 'C:\\b\\two.txt', size: 2 }],
        'local'
      )

      expect(state.recorded.map((r) => r.path)).toEqual(['C:\\a\\one.txt', 'C:\\b\\two.txt'])
      for (const record of state.recorded) {
        expect(record.category).toBe('Recycle Bin')
        expect(record.origin).toBe('local')
        expect(Number.isNaN(Date.parse(record.ts))).toBe(false)
      }
    })

    it('records only the items that are actually gone', async () => {
      state.enumerations = [binItems([{ name: 'two.txt', origin: 'C:\\b' }])]
      await recordEmptiedRecycleBin(
        [{ path: 'C:\\a\\one.txt', size: 1 }, { path: join('C:\\b', 'two.txt'), size: 2 }],
        'local'
      )

      expect(state.recorded.map((r) => r.path)).toEqual(['C:\\a\\one.txt'])
    })

    it('records nothing when every item survived', async () => {
      state.enumerations = [binItems([{ name: 'one.txt', origin: 'C:\\a' }])]
      await recordEmptiedRecycleBin([{ path: join('C:\\a', 'one.txt'), size: 1 }], 'local')
      expect(state.recorded).toHaveLength(0)
    })

    it('does nothing when the bin was empty to begin with', async () => {
      await recordEmptiedRecycleBin([], 'local')
      expect(state.recorded).toHaveLength(0)
      // No re-read is issued either.
      expect(state.enumerations).toHaveLength(0)
    })

    it('carries the calling surface through, so CLI cleans are separable', async () => {
      state.enumerations = ['[]']
      await recordEmptiedRecycleBin([{ path: 'C:\\a\\one.txt', size: 1 }], 'cli')
      expect(state.recorded[0].origin).toBe('cli')
    })
  })
})
