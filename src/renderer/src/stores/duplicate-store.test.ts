import { describe, it, expect, beforeEach } from 'vitest'
import { useDuplicateStore } from './duplicate-store'
import type { DuplicateScanResult } from '@shared/types'

function makeResult(groups: { hash: string; fileSize: number; paths: string[] }[]): DuplicateScanResult {
  return {
    groups: groups.map((g) => ({
      hash: g.hash.slice(0, 16),
      fullHash: g.hash,
      fileSize: g.fileSize,
      files: g.paths.map((p) => ({ path: p, size: g.fileSize, lastModified: Date.now() })),
      reclaimableSpace: g.fileSize * (g.paths.length - 1)
    })),
    totalDuplicates: groups.reduce((s, g) => s + g.paths.length - 1, 0),
    totalReclaimable: groups.reduce((s, g) => s + g.fileSize * (g.paths.length - 1), 0),
    totalFilesScanned: 1000,
    duration: 500,
    cancelled: false
  }
}

describe('duplicate-store', () => {
  beforeEach(() => {
    const store = useDuplicateStore.getState()
    store.reset()
    store.setDirectory(null)
    store.setMinFileSize(1_048_576)
    store.setMaxFileSize(null)
    store.setExcludePatterns(['node_modules', '.git', '$Recycle.Bin'])
    store.setExtensionFilter([])
    store.setMaxDepth(20)
    store.setDeleteMode('recycle')
  })

  it('starts in idle state with sensible defaults', () => {
    const state = useDuplicateStore.getState()
    expect(state.status).toBe('idle')
    expect(state.directory).toBeNull()
    expect(state.minFileSize).toBe(1_048_576)
    expect(state.maxFileSize).toBeNull()
    expect(state.maxDepth).toBe(20)
    expect(state.excludePatterns).toContain('node_modules')
    expect(state.excludePatterns).toContain('.git')
    expect(state.extensionFilter).toEqual([])
    expect(state.result).toBeNull()
    expect(state.selectedPaths.size).toBe(0)
    expect(state.deleteMode).toBe('recycle')
  })

  it('setDirectory updates the directory', () => {
    useDuplicateStore.getState().setDirectory('C:\\Users')
    expect(useDuplicateStore.getState().directory).toBe('C:\\Users')
  })

  it('config setters update their values', () => {
    const store = useDuplicateStore.getState()
    store.setMinFileSize(100)
    store.setMaxFileSize(5000)
    store.setMaxDepth(5)
    store.setExcludePatterns(['dist'])
    store.setExtensionFilter(['.jpg', '.png'])
    store.setDeleteMode('permanent')

    const state = useDuplicateStore.getState()
    expect(state.minFileSize).toBe(100)
    expect(state.maxFileSize).toBe(5000)
    expect(state.maxDepth).toBe(5)
    expect(state.excludePatterns).toEqual(['dist'])
    expect(state.extensionFilter).toEqual(['.jpg', '.png'])
    expect(state.deleteMode).toBe('permanent')
  })

  it('togglePath adds and removes paths from selection', () => {
    useDuplicateStore.getState().togglePath('/a/file1.txt')
    expect(useDuplicateStore.getState().selectedPaths.has('/a/file1.txt')).toBe(true)

    useDuplicateStore.getState().togglePath('/a/file1.txt')
    expect(useDuplicateStore.getState().selectedPaths.has('/a/file1.txt')).toBe(false)
  })

  it('selectAllDuplicates keeps shortest path per group and selects the rest', () => {
    const result = makeResult([
      {
        hash: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
        fileSize: 1000,
        paths: ['/short.txt', '/a/longer/path.txt', '/a/very/much/longer/path.txt']
      }
    ])
    useDuplicateStore.getState().setResult(result)
    useDuplicateStore.getState().selectAllDuplicates()

    const selected = useDuplicateStore.getState().selectedPaths
    // Shortest path should NOT be selected (kept)
    expect(selected.has('/short.txt')).toBe(false)
    // Longer paths should be selected for deletion
    expect(selected.has('/a/longer/path.txt')).toBe(true)
    expect(selected.has('/a/very/much/longer/path.txt')).toBe(true)
  })

  it('selectAllDuplicates works with multiple groups', () => {
    const result = makeResult([
      {
        hash: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
        fileSize: 500,
        paths: ['/a.txt', '/b/a.txt']
      },
      {
        hash: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
        fileSize: 2000,
        paths: ['/x.dat', '/y/x.dat', '/z/x.dat']
      }
    ])
    useDuplicateStore.getState().setResult(result)
    useDuplicateStore.getState().selectAllDuplicates()

    const selected = useDuplicateStore.getState().selectedPaths
    // Group 1: keep /a.txt, select /b/a.txt
    expect(selected.has('/a.txt')).toBe(false)
    expect(selected.has('/b/a.txt')).toBe(true)
    // Group 2: keep /x.dat, select /y/x.dat and /z/x.dat
    expect(selected.has('/x.dat')).toBe(false)
    expect(selected.has('/y/x.dat')).toBe(true)
    expect(selected.has('/z/x.dat')).toBe(true)
    // Total: 3 selected (1 from group1 + 2 from group2)
    expect(selected.size).toBe(3)
  })

  it('deselectAll clears all selections', () => {
    useDuplicateStore.getState().togglePath('/a')
    useDuplicateStore.getState().togglePath('/b')
    expect(useDuplicateStore.getState().selectedPaths.size).toBe(2)

    useDuplicateStore.getState().deselectAll()
    expect(useDuplicateStore.getState().selectedPaths.size).toBe(0)
  })

  it('selectAllDuplicates does nothing without a result', () => {
    useDuplicateStore.getState().selectAllDuplicates()
    expect(useDuplicateStore.getState().selectedPaths.size).toBe(0)
  })

  it('removeDeletedFiles strips deleted paths from groups and recalculates totals', () => {
    const result = makeResult([
      {
        hash: 'dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444',
        fileSize: 1000,
        paths: ['/a.txt', '/b.txt', '/c.txt']
      }
    ])
    useDuplicateStore.getState().setResult(result)
    useDuplicateStore.getState().togglePath('/b.txt')
    useDuplicateStore.getState().togglePath('/c.txt')

    // Delete /b.txt only
    useDuplicateStore.getState().removeDeletedFiles(new Set(['/b.txt']))

    const state = useDuplicateStore.getState()
    // Group should still exist with 2 files remaining
    expect(state.result!.groups).toHaveLength(1)
    expect(state.result!.groups[0].files).toHaveLength(2)
    expect(state.result!.groups[0].files.map((f) => f.path).sort()).toEqual(['/a.txt', '/c.txt'])
    // Reclaimable recalculated: 1000 * (2-1) = 1000
    expect(state.result!.groups[0].reclaimableSpace).toBe(1000)
    expect(state.result!.totalDuplicates).toBe(1)
    expect(state.result!.totalReclaimable).toBe(1000)
    // /b.txt removed from selection, /c.txt still selected
    expect(state.selectedPaths.has('/b.txt')).toBe(false)
    expect(state.selectedPaths.has('/c.txt')).toBe(true)
  })

  it('removeDeletedFiles drops groups with fewer than 2 files remaining', () => {
    const result = makeResult([
      {
        hash: 'eeee5555eeee5555eeee5555eeee5555eeee5555eeee5555eeee5555eeee5555',
        fileSize: 500,
        paths: ['/x.txt', '/y.txt']
      },
      {
        hash: 'ffff6666ffff6666ffff6666ffff6666ffff6666ffff6666ffff6666ffff6666',
        fileSize: 2000,
        paths: ['/p.dat', '/q.dat', '/r.dat']
      }
    ])
    useDuplicateStore.getState().setResult(result)

    // Delete /y.txt — leaves first group with only 1 file, should be dropped
    useDuplicateStore.getState().removeDeletedFiles(new Set(['/y.txt']))

    const state = useDuplicateStore.getState()
    expect(state.result!.groups).toHaveLength(1)
    expect(state.result!.groups[0].fullHash).toBe('ffff6666ffff6666ffff6666ffff6666ffff6666ffff6666ffff6666ffff6666')
    expect(state.result!.totalDuplicates).toBe(2) // 3 files - 1 kept = 2
    expect(state.result!.totalReclaimable).toBe(4000) // 2000 * 2
  })

  it('removeDeletedFiles handles deleting all duplicates from all groups', () => {
    const result = makeResult([
      {
        hash: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
        fileSize: 100,
        paths: ['/a', '/b']
      }
    ])
    useDuplicateStore.getState().setResult(result)

    // Delete both — group has 0 files, should be dropped
    useDuplicateStore.getState().removeDeletedFiles(new Set(['/a', '/b']))

    const state = useDuplicateStore.getState()
    expect(state.result!.groups).toHaveLength(0)
    expect(state.result!.totalDuplicates).toBe(0)
    expect(state.result!.totalReclaimable).toBe(0)
  })

  it('reset clears scan state but preserves config', () => {
    const store = useDuplicateStore.getState()
    store.setDirectory('/home/user')
    store.setMinFileSize(500)
    store.setStatus('complete')
    store.setResult(makeResult([{
      hash: 'cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333',
      fileSize: 100,
      paths: ['/a', '/b']
    }]))
    store.togglePath('/a')

    useDuplicateStore.getState().reset()
    const state = useDuplicateStore.getState()

    // Scan state cleared
    expect(state.status).toBe('idle')
    expect(state.result).toBeNull()
    expect(state.progress).toBeNull()
    expect(state.selectedPaths.size).toBe(0)
    expect(state.deleteResult).toBeNull()

    // Config preserved
    expect(state.directory).toBe('/home/user')
    expect(state.minFileSize).toBe(500)
  })

  it('setStatus transitions correctly', () => {
    const store = useDuplicateStore.getState()
    expect(store.status).toBe('idle')

    store.setStatus('scanning')
    expect(useDuplicateStore.getState().status).toBe('scanning')

    store.setStatus('complete')
    expect(useDuplicateStore.getState().status).toBe('complete')

    store.setStatus('deleting')
    expect(useDuplicateStore.getState().status).toBe('deleting')
  })
})
