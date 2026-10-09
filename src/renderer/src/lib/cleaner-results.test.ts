import { describe, expect, it, vi } from 'vitest'
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

  it.each(['install', 'INSTALL'])(
    'keeps path search and highlighting locale-neutral for %s under Turkish casing',
    (query) => {
      const localeLowerCase = String.prototype.toLocaleLowerCase
      const turkishDefault = vi
        .spyOn(String.prototype, 'toLocaleLowerCase')
        .mockImplementation(function (this: string) {
          return localeLowerCase.call(this, 'tr')
        })
      try {
        const inventory = result('system', 'Cache', ['/INSTALL/cache.log', '/install/cache.log'])
        expect(
          filterCleanerResults([inventory], query, new Set(), false, () => '')[0].items
        ).toHaveLength(2)
        for (const path of ['/INSTALL/cache.log', '/install/cache.log']) {
          const parts = splitSearchHighlight(path, query)
          expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual([
            path.slice(1, 8)
          ])
          expect(parts.map((part) => part.text).join('')).toBe(path)
        }
      } finally {
        turkishDefault.mockRestore()
      }
    }
  )

  it.each([
    ['/\u0130nfo/cache.log', 'nfo', ['nfo']],
    ['/\u0130nfo/\u0130nfo', 'nfo', ['nfo', 'nfo']],
    ['/\u0130nfo', 'i', ['\u0130']],
    ['/\u0130nfo', '\u0130', ['\u0130']],
    ['/\u0130\u0130\u0130', '\u0307i', ['\u0130\u0130\u0130']],
    ['/\u{1F4C1}\u0130nfo', 'nfo', ['nfo']]
  ])(
    'maps lowercase match offsets back to the original Unicode path %s for %s',
    (path, query, matches) => {
      const inventory = result('system', 'Cache', [path])
      expect(filterCleanerResults([inventory], query, new Set(), false, () => '')).toHaveLength(1)
      const parts = splitSearchHighlight(path, query)
      expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual(matches)
      expect(parts.map((part) => part.text).join('')).toBe(path)
    }
  )

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
