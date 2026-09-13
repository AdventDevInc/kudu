import { describe, expect, it } from 'vitest'
import { summarizeReceipt, type CleanupReceiptItem } from './cleanup-receipts'

const meta = {
  id: 'run',
  startedAt: '2026-09-13T00:00:00Z',
  origin: 'local' as const,
  pathLogging: false
}
const item = (id: string, overrides: Partial<CleanupReceiptItem> = {}): CleanupReceiptItem => ({
  id,
  category: 'Cache',
  path: '/private/cache/' + id,
  outcome: 'deleted',
  reason: '',
  attempted: true,
  selectedBytes: 100,
  removedBytes: 100,
  ...overrides
})
describe('cleanup receipts', () => {
  it('reconciles terminal entry counts while retaining partial removal bytes', () => {
    const receipt = summarizeReceipt(meta, [
      item('one'),
      item('two', { outcome: 'failed', reason: 'permission-denied', removedBytes: 40 }),
      item('three', {
        outcome: 'skipped',
        reason: 'recently-modified',
        attempted: false,
        removedBytes: 0
      }),
      item('expired', {
        outcome: 'skipped',
        reason: 'scan-result-expired',
        attempted: false,
        selectedBytes: null,
        removedBytes: 0
      })
    ])
    expect(receipt.selected).toBe(receipt.deleted + receipt.skipped + receipt.failed)
    expect(receipt.attempted).toBe(2)
    expect(receipt.removedBytes).toBe(140)
    expect(receipt.unknownSizeItems).toBe(1)
    expect(receipt.details.every((detail) => !('path' in detail))).toBe(true)
  })
  it('bounds detail lists without truncating accounting or leaking paths', () => {
    const receipt = summarizeReceipt(
      meta,
      Array.from({ length: 6000 }, (_, i) => item(String(i)))
    )
    expect(receipt.details).toHaveLength(5000)
    expect(receipt.detailsTruncated).toBe(1000)
    expect(receipt.removedBytes).toBe(600000)
    expect(JSON.stringify(receipt)).not.toContain('/private/')
  })
  it('keeps a single terminal outcome per ID and explicit retry provenance', () => {
    const receipt = summarizeReceipt({ ...meta, pathLogging: true, parentId: 'parent' }, [
      item('one'),
      item('one', { outcome: 'failed', removedBytes: 10 })
    ])
    expect(receipt.selected).toBe(1)
    expect(receipt.failed).toBe(1)
    expect(receipt.parentId).toBe('parent')
    expect(receipt.details[0].path).toBe('/private/cache/one')
  })
})
