import { describe, it, expect, beforeEach } from 'vitest'
import { useNetworkStore } from './network-store'
import type { NetworkItem } from '@shared/types'

function makeItem(id: string, type: NetworkItem['type']): NetworkItem {
  return { id, type, label: `Item ${id}`, detail: 'detail', selected: true }
}

describe('network-store', () => {
  beforeEach(() => {
    useNetworkStore.getState().reset()
  })

  it('starts idle with empty items', () => {
    const state = useNetworkStore.getState()
    expect(state.status).toBe('idle')
    expect(state.items).toEqual([])
    expect(state.selectedIds.size).toBe(0)
  })

  it('toggleItem adds and removes from selection', () => {
    useNetworkStore.getState().toggleItem('x')
    expect(useNetworkStore.getState().selectedIds.has('x')).toBe(true)
    useNetworkStore.getState().toggleItem('x')
    expect(useNetworkStore.getState().selectedIds.has('x')).toBe(false)
  })

  it('toggleCategory selects all items of type when some unselected', () => {
    const items = [
      makeItem('a', 'dns-cache'),
      makeItem('b', 'dns-cache'),
      makeItem('c', 'wifi-profile')
    ]
    useNetworkStore.getState().setItems(items)
    useNetworkStore.getState().setSelectedIds(new Set(['a'])) // only 'a' selected

    useNetworkStore.getState().toggleCategory('dns-cache')
    const selected = useNetworkStore.getState().selectedIds
    expect(selected.has('a')).toBe(true)
    expect(selected.has('b')).toBe(true)
    expect(selected.has('c')).toBe(false) // different type
  })

  it('toggleCategory deselects all items of type when all selected', () => {
    const items = [makeItem('a', 'dns-cache'), makeItem('b', 'dns-cache')]
    useNetworkStore.getState().setItems(items)
    useNetworkStore.getState().setSelectedIds(new Set(['a', 'b']))

    useNetworkStore.getState().toggleCategory('dns-cache')
    const selected = useNetworkStore.getState().selectedIds
    expect(selected.has('a')).toBe(false)
    expect(selected.has('b')).toBe(false)
  })

  it('reset clears state', () => {
    useNetworkStore.getState().setItems([makeItem('a', 'dns-cache')])
    useNetworkStore.getState().setStatus('complete')
    useNetworkStore.getState().reset()
    const state = useNetworkStore.getState()
    expect(state.items).toEqual([])
    expect(state.status).toBe('idle')
    expect(state.selectedIds.size).toBe(0)
  })
})
