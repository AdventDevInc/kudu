import { describe, expect, it } from 'vitest'
import type { ScanResult } from '@shared/types'
import { filterCleanerResults, splitSearchHighlight } from './cleaner-results'

function result(
  category: string,
  subcategory: string,
  paths: string[],
  group?: string
): ScanResult {
  return {
    category,
    subcategory,
    group,
    items: paths.map((path, index) => ({
      id: `${category}-${index}`,
      path,
      size: index + 1,
      category,
      subcategory,
      selected: true,
      lastModified: 0
    })),
    itemCount: paths.length,
    totalSize: paths.reduce((sum, _, index) => sum + index + 1, 0)
  }
}

const labels = (entry: ScanResult) => (entry.category === 'system' ? 'System' : 'Applications')

describe('Cleaner result search', () => {
  it('finds a full-path match beyond the first 50 rows and reports only matching size/count', () => {
    const inventory = result(
      'system',
      'Temp files',
      Array.from({ length: 75 }, (_, index) => `/temp/folder-${index}/cache.log`)
    )
    const matches = filterCleanerResults([inventory], ' FOLDER-74 ', new Set(), false, labels)
    expect(matches[0].items.map((item) => item.id)).toEqual(['system-74'])
    expect(matches[0].itemCount).toBe(1)
    expect(matches[0].totalSize).toBe(75)
    expect(inventory.items).toHaveLength(75)
  })

  it('searches application/group, subcategory, and localized category names across inventories', () => {
    const inventory = [
      result('system', 'Temp files', ['/temp/a']),
      result('app', 'Cache', ['/apps/b'], 'Chrome')
    ]
    expect(filterCleanerResults(inventory, 'chrome', new Set(), false, labels)[0].category).toBe(
      'app'
    )
    expect(
      filterCleanerResults(inventory, 'temp files', new Set(), false, labels)[0].category
    ).toBe('system')
    expect(
      filterCleanerResults(inventory, 'applications', new Set(), false, labels)[0].category
    ).toBe('app')
    expect(filterCleanerResults(inventory, 'missing', new Set(), false, labels)).toEqual([])
  })

  it('combines Selected only with search without changing the inventory or selection', () => {
    const inventory = result('system', 'Temp files', ['/temp/a', '/temp/b'])
    const selected = new Set(['system-1', 'hidden'])
    expect(
      filterCleanerResults([inventory], 'temp', selected, true, labels)[0].items.map(
        (item) => item.id
      )
    ).toEqual(['system-1'])
    expect([...selected]).toEqual(['system-1', 'hidden'])
    expect(inventory.items).toHaveLength(2)
    expect(filterCleanerResults([inventory], 'a', selected, true, () => '')).toEqual([])
  })

  it('highlights repeated literal matches without treating search text as a regular expression', () => {
    const parts = splitSearchHighlight('Cache.[1]/cache.[1]', 'CACHE.[1]')
    expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual([
      'Cache.[1]',
      'cache.[1]'
    ])
    expect(parts.map((part) => part.text).join('')).toBe('Cache.[1]/cache.[1]')
    expect(splitSearchHighlight('Cache', '  ')).toEqual([{ text: 'Cache', match: false }])
  })
})
