import { describe, it, expect, beforeEach } from 'vitest'
import { useDebloaterStore } from './debloater-store'
import type { BloatwareApp } from '@shared/types'

function makeApp(overrides: Partial<BloatwareApp> = {}): BloatwareApp {
  return {
    id: 'app-1',
    name: 'Xbox Game Bar',
    packageName: 'Microsoft.XboxGamingOverlay',
    publisher: 'Microsoft',
    description: 'Gaming overlay',
    category: 'gaming',
    size: '50000000',
    selected: false,
    ...overrides
  }
}

describe('debloater-store', () => {
  beforeEach(() => {
    useDebloaterStore.getState().reset()
  })

  it('starts in clean state', () => {
    const state = useDebloaterStore.getState()
    expect(state.apps).toEqual([])
    expect(state.scanning).toBe(false)
    expect(state.removing).toBe(false)
    expect(state.hasScanned).toBe(false)
    expect(state.filter).toBe('all')
  })

  it('setApps stores bloatware list', () => {
    const apps = [makeApp({ id: '1' }), makeApp({ id: '2' })]
    useDebloaterStore.getState().setApps(apps)
    expect(useDebloaterStore.getState().apps).toHaveLength(2)
  })

  it('toggleApp flips selection on specific app', () => {
    useDebloaterStore
      .getState()
      .setApps([makeApp({ id: '1', selected: false }), makeApp({ id: '2', selected: false })])

    useDebloaterStore.getState().toggleApp('1')
    expect(useDebloaterStore.getState().apps[0].selected).toBe(true)
    expect(useDebloaterStore.getState().apps[1].selected).toBe(false)
  })

  it('selectAll selects every app', () => {
    useDebloaterStore
      .getState()
      .setApps([makeApp({ id: '1', selected: false }), makeApp({ id: '2', selected: false })])

    useDebloaterStore.getState().selectAll()
    expect(useDebloaterStore.getState().apps.every((a) => a.selected)).toBe(true)
  })

  it('deselectAll deselects every app', () => {
    useDebloaterStore
      .getState()
      .setApps([makeApp({ id: '1', selected: true }), makeApp({ id: '2', selected: true })])

    useDebloaterStore.getState().deselectAll()
    expect(useDebloaterStore.getState().apps.every((a) => !a.selected)).toBe(true)
  })

  it('selectFiltered selects only apps matching the filter', () => {
    useDebloaterStore
      .getState()
      .setApps([
        makeApp({ id: '1', category: 'gaming', selected: false }),
        makeApp({ id: '2', category: 'communication', selected: false }),
        makeApp({ id: '3', category: 'gaming', selected: false })
      ])

    useDebloaterStore.getState().selectFiltered('gaming', true)
    const apps = useDebloaterStore.getState().apps
    expect(apps[0].selected).toBe(true)
    expect(apps[1].selected).toBe(false) // communication
    expect(apps[2].selected).toBe(true)
  })

  it('selectFiltered with "all" selects/deselects everything', () => {
    useDebloaterStore
      .getState()
      .setApps([makeApp({ id: '1', selected: false }), makeApp({ id: '2', selected: false })])

    useDebloaterStore.getState().selectFiltered('all', true)
    expect(useDebloaterStore.getState().apps.every((a) => a.selected)).toBe(true)

    useDebloaterStore.getState().selectFiltered('all', false)
    expect(useDebloaterStore.getState().apps.every((a) => !a.selected)).toBe(true)
  })

  it('setFilter changes the active filter', () => {
    useDebloaterStore.getState().setFilter('gaming')
    expect(useDebloaterStore.getState().filter).toBe('gaming')
  })

  it('setRemoveProgress tracks removal progress', () => {
    useDebloaterStore.getState().setRemoveProgress({
      current: 2,
      total: 5,
      currentApp: 'Xbox',
      status: 'Removing...'
    })
    expect(useDebloaterStore.getState().removeProgress).toEqual({
      current: 2,
      total: 5,
      currentApp: 'Xbox',
      status: 'Removing...'
    })
  })

  it('setRemoveResult stores final result', () => {
    useDebloaterStore.getState().setRemoveResult({ removed: 3, failed: 1 })
    expect(useDebloaterStore.getState().removeResult).toEqual({ removed: 3, failed: 1 })
  })

  it('reset clears everything', () => {
    useDebloaterStore.getState().setApps([makeApp()])
    useDebloaterStore.getState().setFilter('gaming')
    useDebloaterStore.getState().setError('err')
    useDebloaterStore.getState().setHasScanned(true)

    useDebloaterStore.getState().reset()

    const state = useDebloaterStore.getState()
    expect(state.apps).toEqual([])
    expect(state.filter).toBe('all')
    expect(state.error).toBeNull()
    expect(state.hasScanned).toBe(false)
  })
})
