import { describe, expect, it } from 'vitest'
import type { ScanResult } from '@shared/types'
import { dashboardCleanIds } from './dashboard-cleaner'

function result(subcategory: string, selected = true): ScanResult {
  return {
    category: 'system',
    subcategory,
    totalSize: 10,
    itemCount: 1,
    items: [
      {
        id: subcategory,
        category: 'system',
        subcategory,
        selected,
        path: 'C:/test/' + subcategory,
        size: 10,
        lastModified: 0
      }
    ]
  }
}

describe('dashboard one-click cleaning', () => {
  it('excludes rollback for fresh users even if a scanner marks it selected', () => {
    expect(
      dashboardCleanIds([result('Previous Windows Installation'), result('Temp')], new Set())
    ).toEqual(['Temp'])
  })

  it('honors default opt-outs and remembered exclusions while cleaning ordinary items', () => {
    expect(
      dashboardCleanIds(
        [
          result('Previous Windows Installation', false),
          result('Optional cache', false),
          result('Excluded'),
          result('Temp')
        ],
        new Set(['Excluded'])
      )
    ).toEqual(['Temp'])
  })
})
