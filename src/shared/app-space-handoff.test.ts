import { describe, expect, it } from 'vitest'
import { getAppSpaceCleanerView } from './app-space-handoff'
import type { ScanResult } from './types'
const result = (category: string, group?: string): ScanResult => ({
  category,
  group,
  subcategory: 'test',
  items: [],
  itemCount: 0,
  totalSize: 0
})
describe('App Space cleaner view', () => {
  it('opens AI Tools when app results belong only to that group', () => {
    expect(getAppSpaceCleanerView([result('app', 'AI Tools')])).toEqual({
      appSpaceCategory: 'aiTools',
      appSpaceAll: false
    })
  })
  it('opens all scope for mixed AI and ordinary app results in the same category', () => {
    expect(getAppSpaceCleanerView([result('app', 'AI Tools'), result('app')])).toEqual({
      appSpaceCategory: 'aiTools',
      appSpaceAll: true
    })
    expect(getAppSpaceCleanerView([result('app'), result('app', 'AI Tools')])).toEqual({
      appSpaceCategory: 'app',
      appSpaceAll: true
    })
  })
  it('keeps regular app reviews scoped and handles mixed categories', () => {
    expect(getAppSpaceCleanerView([result('app'), result('app')])).toEqual({
      appSpaceCategory: 'app',
      appSpaceAll: false
    })
    expect(getAppSpaceCleanerView([result('browser'), result('app', 'AI Tools')])).toEqual({
      appSpaceCategory: 'browser',
      appSpaceAll: true
    })
  })
})
