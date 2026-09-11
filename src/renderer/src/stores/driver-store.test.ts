import { describe, it, expect, beforeEach } from 'vitest'
import { useDriverStore } from './driver-store'
import type { DriverPackage, DriverUpdate } from '@shared/types'

function makePackage(id: string, isCurrent: boolean, selected = false): DriverPackage {
  return {
    id,
    publishedName: `${id}.inf`,
    originalName: `${id}.inf`,
    provider: 'Test',
    className: 'Display',
    version: '1.0.0',
    date: '2025-01-01',
    signer: 'Test Corp',
    folderPath: `C:\\drivers\\${id}`,
    size: 1024,
    isCurrent,
    selected
  }
}

function makeUpdate(id: string, selected = false): DriverUpdate {
  return {
    id,
    updateId: `update-${id}`,
    deviceName: `Device ${id}`,
    deviceId: `dev-${id}`,
    className: 'Display',
    currentVersion: '1.0',
    currentDate: '2025-01-01',
    availableVersion: '2.0',
    availableDate: '2025-06-01',
    provider: 'Test',
    updateTitle: `Update ${id}`,
    downloadSize: '10 MB',
    selected
  }
}

describe('driver-store', () => {
  beforeEach(() => {
    useDriverStore.getState().reset()
  })

  describe('cleanup', () => {
    it('togglePackage only toggles stale drivers (not current)', () => {
      useDriverStore
        .getState()
        .setPackages([makePackage('stale', false), makePackage('current', true)])
      useDriverStore.getState().togglePackage('stale')
      useDriverStore.getState().togglePackage('current')
      const pkgs = useDriverStore.getState().packages
      expect(pkgs.find((p) => p.id === 'stale')!.selected).toBe(true)
      expect(pkgs.find((p) => p.id === 'current')!.selected).toBe(false) // protected
    })

    it('selectAllStale selects only non-current packages', () => {
      useDriverStore
        .getState()
        .setPackages([
          makePackage('stale1', false),
          makePackage('stale2', false),
          makePackage('current', true)
        ])
      useDriverStore.getState().selectAllStale()
      const pkgs = useDriverStore.getState().packages
      expect(pkgs.filter((p) => p.selected)).toHaveLength(2)
      expect(pkgs.find((p) => p.id === 'current')!.selected).toBe(false)
    })

    it('deselectAllStale deselects stale packages', () => {
      useDriverStore
        .getState()
        .setPackages([makePackage('stale', false, true), makePackage('current', true, true)])
      useDriverStore.getState().deselectAllStale()
      const pkgs = useDriverStore.getState().packages
      expect(pkgs.find((p) => p.id === 'stale')!.selected).toBe(false)
      expect(pkgs.find((p) => p.id === 'current')!.selected).toBe(true) // untouched
    })
  })

  describe('updates', () => {
    it('toggleUpdate toggles selection', () => {
      useDriverStore.getState().setUpdates([makeUpdate('a'), makeUpdate('b')])
      useDriverStore.getState().toggleUpdate('a')
      const updates = useDriverStore.getState().updates
      expect(updates.find((u) => u.id === 'a')!.selected).toBe(true)
      expect(updates.find((u) => u.id === 'b')!.selected).toBe(false)
    })

    it('selectAllUpdates selects all', () => {
      useDriverStore.getState().setUpdates([makeUpdate('a'), makeUpdate('b')])
      useDriverStore.getState().selectAllUpdates()
      expect(useDriverStore.getState().updates.every((u) => u.selected)).toBe(true)
    })

    it('deselectAllUpdates deselects all', () => {
      useDriverStore.getState().setUpdates([makeUpdate('a', true), makeUpdate('b', true)])
      useDriverStore.getState().deselectAllUpdates()
      expect(useDriverStore.getState().updates.every((u) => !u.selected)).toBe(true)
    })
  })

  it('reset clears all state', () => {
    useDriverStore.getState().setPackages([makePackage('a', false)])
    useDriverStore.getState().setUpdates([makeUpdate('b')])
    useDriverStore.getState().setScanning(true)
    useDriverStore.getState().reset()
    const state = useDriverStore.getState()
    expect(state.packages).toEqual([])
    expect(state.updates).toEqual([])
    expect(state.scanning).toBe(false)
  })
})
