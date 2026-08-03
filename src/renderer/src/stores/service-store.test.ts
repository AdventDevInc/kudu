import { describe, it, expect, beforeEach } from 'vitest'
import { useServiceStore } from './service-store'
import type { WindowsService, ServiceSafety, ServiceStartType, ServiceStatus } from '@shared/types'

function makeService(
  name: string,
  safety: ServiceSafety = 'safe',
  startType: ServiceStartType = 'Automatic',
  status: ServiceStatus = 'Running',
  selected = false
): WindowsService {
  return {
    name,
    displayName: `${name} Display`,
    description: `Description for ${name}`,
    status,
    startType,
    safety,
    category: 'misc',
    isMicrosoft: true,
    dependsOn: [],
    dependents: [],
    selected,
    originalStartType: startType
  }
}

describe('service-store', () => {
  beforeEach(() => {
    useServiceStore.getState().reset()
  })

  describe('toggleService', () => {
    it('toggles a safe service', () => {
      useServiceStore.getState().setServices([makeService('DiagTrack', 'safe')])
      useServiceStore.getState().toggleService('DiagTrack')
      expect(useServiceStore.getState().services[0].selected).toBe(true)
    })

    it('toggles a caution service', () => {
      useServiceStore.getState().setServices([makeService('WSearch', 'caution')])
      useServiceStore.getState().toggleService('WSearch')
      expect(useServiceStore.getState().services[0].selected).toBe(true)
    })

    it('does NOT toggle an unsafe service', () => {
      useServiceStore.getState().setServices([makeService('RpcSs', 'unsafe')])
      useServiceStore.getState().toggleService('RpcSs')
      expect(useServiceStore.getState().services[0].selected).toBe(false)
    })

    it('toggles a disabled service so it can be re-enabled', () => {
      useServiceStore.getState().setServices([makeService('seclogon', 'caution', 'Disabled', 'Stopped')])
      useServiceStore.getState().toggleService('seclogon')
      expect(useServiceStore.getState().services[0].selected).toBe(true)
    })

    it('toggles an unsafe service that is already disabled', () => {
      useServiceStore.getState().setServices([makeService('RpcSs', 'unsafe', 'Disabled', 'Stopped')])
      useServiceStore.getState().toggleService('RpcSs')
      expect(useServiceStore.getState().services[0].selected).toBe(true)
    })
  })

  describe('selectRecommended', () => {
    it('selects only safe, non-disabled services', () => {
      useServiceStore.getState().setServices([
        makeService('DiagTrack', 'safe', 'Automatic'),
        makeService('Fax', 'safe', 'Disabled'),
        makeService('WSearch', 'caution', 'Automatic'),
        makeService('RpcSs', 'unsafe', 'Automatic')
      ])
      useServiceStore.getState().selectRecommended()
      const services = useServiceStore.getState().services
      expect(services[0].selected).toBe(true)   // safe + not disabled
      expect(services[1].selected).toBe(false)   // safe but already disabled
      expect(services[2].selected).toBe(false)   // caution
      expect(services[3].selected).toBe(false)   // unsafe
    })
  })

  describe('deselectAll', () => {
    it('deselects all services', () => {
      useServiceStore.getState().setServices([
        makeService('a', 'safe', 'Automatic', 'Running', true),
        makeService('b', 'caution', 'Manual', 'Stopped', true)
      ])
      useServiceStore.getState().deselectAll()
      expect(useServiceStore.getState().services.every((s) => !s.selected)).toBe(true)
    })
  })

  describe('filters', () => {
    it('sets search query', () => {
      useServiceStore.getState().setSearchQuery('xbox')
      expect(useServiceStore.getState().searchQuery).toBe('xbox')
    })

    it('sets safety filter', () => {
      useServiceStore.getState().setSafetyFilter('safe')
      expect(useServiceStore.getState().safetyFilter).toBe('safe')
    })

    it('sets category filter', () => {
      useServiceStore.getState().setCategoryFilter('telemetry')
      expect(useServiceStore.getState().categoryFilter).toBe('telemetry')
    })

    it('sets status filter', () => {
      useServiceStore.getState().setStatusFilter('running')
      expect(useServiceStore.getState().statusFilter).toBe('running')
    })
  })

  it('reset clears all state', () => {
    useServiceStore.getState().setServices([makeService('a')])
    useServiceStore.getState().setScanning(true)
    useServiceStore.getState().setSearchQuery('test')
    useServiceStore.getState().setSafetyFilter('safe')
    useServiceStore.getState().reset()
    const state = useServiceStore.getState()
    expect(state.services).toEqual([])
    expect(state.scanning).toBe(false)
    expect(state.searchQuery).toBe('')
    expect(state.safetyFilter).toBe('all')
    expect(state.hasScanned).toBe(false)
  })
})
