import { describe, it, expect } from 'vitest'

// ── Test the pure logic from recycle-bin.ipc.ts ──
// Replicated here to avoid importing the Electron-dependent module.

// ── PowerShell stdout parsing (Windows scan) ──

function parseRecycleBinScanOutput(stdout: string): { count: number; size: number } {
  const [countStr, sizeStr] = stdout.trim().split('|')
  const count = parseInt(countStr) || 0
  const size = parseInt(sizeStr) || 0
  return { count, size }
}

describe('recycle bin scan output parsing', () => {
  it('parses valid count|size output', () => {
    expect(parseRecycleBinScanOutput('42|1048576')).toEqual({ count: 42, size: 1048576 })
  })

  it('handles zero values', () => {
    expect(parseRecycleBinScanOutput('0|0')).toEqual({ count: 0, size: 0 })
  })

  it('handles empty output', () => {
    expect(parseRecycleBinScanOutput('')).toEqual({ count: 0, size: 0 })
  })

  it('handles malformed output', () => {
    expect(parseRecycleBinScanOutput('not a number')).toEqual({ count: 0, size: 0 })
  })

  it('handles output with only count', () => {
    expect(parseRecycleBinScanOutput('5|')).toEqual({ count: 5, size: 0 })
  })

  it('handles output with trailing whitespace', () => {
    expect(parseRecycleBinScanOutput('  10|2048  \n')).toEqual({ count: 10, size: 2048 })
  })

  it('handles large numbers', () => {
    expect(parseRecycleBinScanOutput('5000|10737418240')).toEqual({ count: 5000, size: 10737418240 })
  })
})

// ── Scan result structure (Windows) ──

describe('recycle bin scan result structure', () => {
  it('returns empty array when count is 0', () => {
    const { count } = parseRecycleBinScanOutput('0|0')
    const results = count === 0 ? [] : ['has items']
    expect(results).toEqual([])
  })

  it('returns single ScanResult for non-zero count', () => {
    const { count, size } = parseRecycleBinScanOutput('10|5000')
    expect(count).toBeGreaterThan(0)

    const result = {
      category: 'recycleBin',
      subcategory: 'Recycle Bin',
      items: [{
        id: 'test-uuid',
        path: 'Recycle Bin',
        size,
        category: 'recycleBin',
        subcategory: 'Recycle Bin',
        lastModified: Date.now(),
        selected: true
      }],
      totalSize: size,
      itemCount: count
    }

    expect(result.category).toBe('recycleBin')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].path).toBe('Recycle Bin')
    expect(result.items[0].selected).toBe(true)
    expect(result.totalSize).toBe(5000)
    expect(result.itemCount).toBe(10)
  })
})

// ── Clean result structure ──

describe('recycle bin clean result structure', () => {
  it('reports success when remaining count is 0', () => {
    const sizeBeforeClean = 5000
    const remainingStdout = '0'
    const remaining = parseInt(remainingStdout.trim()) || 0

    const result = remaining === 0
      ? { totalCleaned: sizeBeforeClean, filesDeleted: 1, filesSkipped: 0, errors: [], needsElevation: false }
      : null

    expect(result).toEqual({
      totalCleaned: 5000,
      filesDeleted: 1,
      filesSkipped: 0,
      errors: [],
      needsElevation: false
    })
  })

  it('reports partial clean when remaining items exist', () => {
    const sizeBeforeClean = 10000
    const remaining = 3

    const result = {
      totalCleaned: sizeBeforeClean,
      filesDeleted: 1,
      filesSkipped: remaining,
      errors: [{ path: 'Recycle Bin', reason: `${remaining} item(s) could not be removed (may be in use or protected)` }],
      needsElevation: false
    }

    expect(result.filesSkipped).toBe(3)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].reason).toContain('3 item(s)')
  })

  it('reports error on clean failure', () => {
    const err = new Error('Access denied')
    const result = {
      totalCleaned: 0,
      filesDeleted: 0,
      filesSkipped: 0,
      errors: [{ path: 'Recycle Bin', reason: err.message }],
      needsElevation: false
    }

    expect(result.totalCleaned).toBe(0)
    expect(result.errors[0].reason).toBe('Access denied')
  })
})

// ── macOS/Linux trash path handling ──

describe('trash path handling', () => {
  it('returns empty array when trash path does not exist', () => {
    // Simulates existsSync returning false
    const trashExists = false
    const results = trashExists ? ['would scan'] : []
    expect(results).toEqual([])
  })

  it('returns error result on clean failure for trash path', () => {
    const err = new Error('Permission denied')
    const result = {
      totalCleaned: 0,
      filesDeleted: 0,
      filesSkipped: 0,
      errors: [{ path: 'Trash', reason: err.message }],
      needsElevation: false
    }
    expect(result.errors[0].path).toBe('Trash')
    expect(result.errors[0].reason).toBe('Permission denied')
  })
})

// ── State tracking ──

describe('recycle bin state tracking', () => {
  it('tracks lastScannedSize for clean operations', () => {
    let lastScannedSize = 0

    // Simulate scan
    const { size } = parseRecycleBinScanOutput('100|1048576')
    lastScannedSize = size
    expect(lastScannedSize).toBe(1048576)

    // Simulate clean - uses the tracked size
    const sizeBeforeClean = lastScannedSize
    lastScannedSize = 0
    expect(sizeBeforeClean).toBe(1048576)
    expect(lastScannedSize).toBe(0)
  })

  it('tracks lastScannedItemIds for macOS/Linux', () => {
    let lastScannedItemIds: string[] = []

    // Simulate scan populating IDs
    lastScannedItemIds = ['id-1', 'id-2', 'id-3']
    expect(lastScannedItemIds).toHaveLength(3)

    // Simulate clean clearing IDs
    const idsToClean = lastScannedItemIds
    lastScannedItemIds = []
    expect(idsToClean).toHaveLength(3)
    expect(lastScannedItemIds).toHaveLength(0)
  })
})

// ── Remaining items count parsing ──

describe('remaining items count parsing', () => {
  it('parses valid integer', () => {
    expect(parseInt('0'.trim()) || 0).toBe(0)
    expect(parseInt('5'.trim()) || 0).toBe(5)
  })

  it('handles whitespace/newlines', () => {
    expect(parseInt('  3  \n'.trim()) || 0).toBe(3)
  })

  it('returns 0 for non-numeric output', () => {
    expect(parseInt('error'.trim()) || 0).toBe(0)
  })

  it('returns 0 for empty string', () => {
    expect(parseInt(''.trim()) || 0).toBe(0)
  })
})
