import { describe, it, expect, beforeEach } from 'vitest'
import {
  cacheItems, getCachedItem, getCachedItems, clearCache,
  clearCachedCategory, removeCachedItems
} from './scan-cache'
import type { ScanItem } from '../../shared/types'

function makeItem(id: string): ScanItem {
  return {
    id,
    path: `C:\\temp\\${id}`,
    size: 1024,
    category: 'system',
    subcategory: 'temp',
    lastModified: Date.now(),
    selected: true,
  }
}

describe('scan-cache', () => {
  beforeEach(() => {
    clearCache()
  })

  it('caches and retrieves a single item by id', () => {
    const item = makeItem('a')
    cacheItems([item])
    expect(getCachedItem('a')).toEqual(item)
  })

  it('returns undefined for unknown id', () => {
    expect(getCachedItem('nonexistent')).toBeUndefined()
  })

  it('caches multiple items and retrieves a subset', () => {
    const items = [makeItem('a'), makeItem('b'), makeItem('c')]
    cacheItems(items)
    const result = getCachedItems(['a', 'c'])
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('a')
    expect(result[1].id).toBe('c')
  })

  it('skips unknown ids in getCachedItems', () => {
    cacheItems([makeItem('x')])
    const result = getCachedItems(['x', 'missing'])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('x')
  })

  it('clearCache removes all items', () => {
    cacheItems([makeItem('a'), makeItem('b')])
    clearCache()
    expect(getCachedItem('a')).toBeUndefined()
    expect(getCachedItem('b')).toBeUndefined()
  })

  it('overwrites items with the same id', () => {
    const item1 = makeItem('a')
    const item2 = { ...makeItem('a'), size: 9999 }
    cacheItems([item1])
    cacheItems([item2])
    expect(getCachedItem('a')?.size).toBe(9999)
  })

  it('keeps every item in a scan larger than the old 50,000 item cap', () => {
    const batch1 = Array.from({ length: 50000 }, (_, i) => makeItem(`old-${i}`))
    cacheItems(batch1)
    cacheItems([makeItem('new-item')])

    expect(getCachedItem('old-0')).toBeDefined()
    expect(getCachedItem('new-item')).toBeDefined()
  })

  it('clears only the requested category before a replacement scan', () => {
    cacheItems([
      makeItem('system-old'),
      { ...makeItem('browser-old'), category: 'browser' },
    ])

    clearCachedCategory('system')

    expect(getCachedItem('system-old')).toBeUndefined()
    expect(getCachedItem('browser-old')).toBeDefined()
  })

  it('removes consumed IDs after cleaning', () => {
    cacheItems([makeItem('a'), makeItem('b')])
    removeCachedItems(['a'])
    expect(getCachedItem('a')).toBeUndefined()
    expect(getCachedItem('b')).toBeDefined()
  })
})
