import { describe, it, expect, beforeEach } from 'vitest'
import { useRegistryStore } from './registry-store'
import type { RegistryEntry } from '@shared/types'

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: 'entry-1',
    type: 'broken',
    keyPath: 'HKCR\\.xyz',
    valueName: '',
    issue: 'Broken file association',
    risk: 'low' as const,
    selected: false,
    ...overrides
  }
}

describe('registry-store', () => {
  beforeEach(() => {
    useRegistryStore.getState().reset()
  })

  it('starts in clean state', () => {
    const state = useRegistryStore.getState()
    expect(state.entries).toEqual([])
    expect(state.scanning).toBe(false)
    expect(state.scanned).toBe(false)
    expect(state.fixing).toBe(false)
    expect(state.fixResult).toBeNull()
    expect(state.error).toBeNull()
  })

  it('setEntries stores entries', () => {
    const entries = [makeEntry({ id: '1' }), makeEntry({ id: '2' })]
    useRegistryStore.getState().setEntries(entries)
    expect(useRegistryStore.getState().entries).toHaveLength(2)
  })

  it('toggleEntry flips selected on specific entry', () => {
    useRegistryStore
      .getState()
      .setEntries([
        makeEntry({ id: '1', selected: false }),
        makeEntry({ id: '2', selected: false })
      ])

    useRegistryStore.getState().toggleEntry('1')
    const entries = useRegistryStore.getState().entries
    expect(entries[0].selected).toBe(true)
    expect(entries[1].selected).toBe(false)
  })

  it('toggleEntry can toggle back off', () => {
    useRegistryStore.getState().setEntries([makeEntry({ id: '1', selected: true })])
    useRegistryStore.getState().toggleEntry('1')
    expect(useRegistryStore.getState().entries[0].selected).toBe(false)
  })

  it('toggleCardAll selects all entries of given types when not all selected', () => {
    useRegistryStore
      .getState()
      .setEntries([
        makeEntry({ id: '1', type: 'broken', selected: false }),
        makeEntry({ id: '2', type: 'broken', selected: true }),
        makeEntry({ id: '3', type: 'invalid', selected: false })
      ])

    useRegistryStore.getState().toggleCardAll(['broken'])

    const entries = useRegistryStore.getState().entries
    expect(entries[0].selected).toBe(true) // toggled on
    expect(entries[1].selected).toBe(true) // stayed on
    expect(entries[2].selected).toBe(false) // different type, unchanged
  })

  it('toggleCardAll deselects all when all are already selected', () => {
    useRegistryStore
      .getState()
      .setEntries([
        makeEntry({ id: '1', type: 'broken', selected: true }),
        makeEntry({ id: '2', type: 'broken', selected: true })
      ])

    useRegistryStore.getState().toggleCardAll(['broken'])

    const entries = useRegistryStore.getState().entries
    expect(entries[0].selected).toBe(false)
    expect(entries[1].selected).toBe(false)
  })

  it('toggleCardAll works with multiple types', () => {
    useRegistryStore
      .getState()
      .setEntries([
        makeEntry({ id: '1', type: 'broken', selected: false }),
        makeEntry({ id: '2', type: 'invalid', selected: false }),
        makeEntry({ id: '3', type: 'orphaned', selected: false })
      ])

    useRegistryStore.getState().toggleCardAll(['broken', 'invalid'])

    const entries = useRegistryStore.getState().entries
    expect(entries[0].selected).toBe(true)
    expect(entries[1].selected).toBe(true)
    expect(entries[2].selected).toBe(false) // orphan_key not in types
  })

  it('toggleCardExpand toggles card expansion', () => {
    useRegistryStore.getState().toggleCardExpand(0)
    expect(useRegistryStore.getState().expandedCards.has(0)).toBe(true)

    useRegistryStore.getState().toggleCardExpand(0)
    expect(useRegistryStore.getState().expandedCards.has(0)).toBe(false)
  })

  it('setFixResult stores fix result', () => {
    const result = { fixed: 5, failed: 1, failures: [{ issue: 'x', reason: 'y' }] }
    useRegistryStore.getState().setFixResult(result)
    expect(useRegistryStore.getState().fixResult).toEqual(result)
  })

  it('setFixProgress tracks fix progress', () => {
    useRegistryStore
      .getState()
      .setFixProgress({ current: 3, total: 10, currentEntry: 'HKCR\\.xyz' })
    expect(useRegistryStore.getState().fixProgress).toEqual({
      current: 3,
      total: 10,
      currentEntry: 'HKCR\\.xyz'
    })
  })

  it('reset clears all state', () => {
    useRegistryStore.getState().setEntries([makeEntry()])
    useRegistryStore.getState().setScanning(true)
    useRegistryStore.getState().setError('err')

    useRegistryStore.getState().reset()

    const state = useRegistryStore.getState()
    expect(state.entries).toEqual([])
    expect(state.scanning).toBe(false)
    expect(state.error).toBeNull()
    expect(state.fixResult).toBeNull()
  })
})
