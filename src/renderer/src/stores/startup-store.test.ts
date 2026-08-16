import { describe, it, expect, beforeEach } from 'vitest'
import { useStartupStore } from './startup-store'
import type { StartupItem } from '@shared/types'

function makeItem(overrides: Partial<StartupItem> = {}): StartupItem {
  return {
    id: 'item-1',
    name: 'Test App',
    displayName: 'Test App',
    enabled: true,
    source: 'registry-hkcu',
    location: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    command: 'C:\\App\\test.exe',
    impact: 'high',
    publisher: 'Test Inc',
    ...overrides,
  }
}

describe('startup-store', () => {
  beforeEach(() => {
    useStartupStore.getState().reset()
  })

  it('starts with empty state', () => {
    const state = useStartupStore.getState()
    expect(state.items).toEqual([])
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    expect(state.bootTrace).toBeNull()
  })

  it('setItems replaces all items', () => {
    const items = [makeItem({ id: '1' }), makeItem({ id: '2', name: 'Other' })]
    useStartupStore.getState().setItems(items)
    expect(useStartupStore.getState().items).toHaveLength(2)
    expect(useStartupStore.getState().hasLoaded).toBe(true)
  })

  it('updateItem updates a specific item by id', () => {
    useStartupStore.getState().setItems([
      makeItem({ id: '1', enabled: true }),
      makeItem({ id: '2', enabled: true }),
    ])

    useStartupStore.getState().updateItem('1', { enabled: false })

    const items = useStartupStore.getState().items
    expect(items[0].enabled).toBe(false)
    expect(items[1].enabled).toBe(true)
  })

  it('removeItem removes the item with given id', () => {
    useStartupStore.getState().setItems([
      makeItem({ id: '1' }),
      makeItem({ id: '2' }),
      makeItem({ id: '3' }),
    ])

    useStartupStore.getState().removeItem('2')
    const ids = useStartupStore.getState().items.map((i) => i.id)
    expect(ids).toEqual(['1', '3'])
  })

  it('setSortBy updates sort preference', () => {
    useStartupStore.getState().setSortBy('name')
    expect(useStartupStore.getState().sortBy).toBe('name')
  })

  it('initial sort is by impact', () => {
    // Reset the full store (reset() preserves sortBy/filterBy)
    useStartupStore.setState({ sortBy: 'impact', filterBy: 'all' })
    expect(useStartupStore.getState().sortBy).toBe('impact')
  })

  it('setFilterBy updates filter', () => {
    useStartupStore.getState().setFilterBy('active')
    expect(useStartupStore.getState().filterBy).toBe('active')
  })

  it('setError stores error message', () => {
    useStartupStore.getState().setError('Something went wrong')
    expect(useStartupStore.getState().error).toBe('Something went wrong')
  })

  it('setDeleteTarget stores item for confirmation', () => {
    const item = makeItem()
    useStartupStore.getState().setDeleteTarget(item)
    expect(useStartupStore.getState().deleteTarget).toEqual(item)
  })

  it('setBootTrace stores trace data', () => {
    const trace = { totalBootTimeMs: 5000, items: [] } as any
    useStartupStore.getState().setBootTrace(trace)
    expect(useStartupStore.getState().bootTrace).toEqual(trace)
  })

  it('reset clears items/error/loading/bootTrace but preserves sort/filter', () => {
    useStartupStore.getState().setItems([makeItem()])
    useStartupStore.getState().setError('err')
    useStartupStore.getState().setSortBy('name')
    useStartupStore.getState().setFilterBy('disabled')

    useStartupStore.getState().reset()

    const state = useStartupStore.getState()
    expect(state.items).toEqual([])
    expect(state.hasLoaded).toBe(false)
    expect(state.error).toBeNull()
    expect(state.loading).toBe(false)
    expect(state.bootTrace).toBeNull()
    // Sort/filter are NOT part of reset() — they persist
    expect(state.sortBy).toBe('name')
    expect(state.filterBy).toBe('disabled')
  })
})
