import { beforeEach, describe, expect, it } from 'vitest'
import { useUninstallerStore } from './uninstaller-store'
import type { InstalledProgram } from '@shared/types'

const programs = ['Firefox', 'Dokan Library', 'WinFsp', 'Microsoft .NET Runtime - 8.0.1'].map(
  (displayName, id) =>
    ({
      id: String(id),
      displayName,
      isSystemComponent: false
    }) as InstalledProgram
)

describe('uninstaller selection', () => {
  beforeEach(() => {
    useUninstallerStore.getState().reset()
    useUninstallerStore.getState().setPrograms(programs)
  })

  it('excludes shared components and unknown IDs from select all', () => {
    useUninstallerStore.getState().selectAll([...programs.map((p) => p.id), 'missing'])
    expect([...useUninstallerStore.getState().selectedIds]).toEqual(['0'])
  })

  it('does not allow manually adding shared components to a batch', () => {
    for (const p of programs) useUninstallerStore.getState().toggleSelected(p.id)
    expect([...useUninstallerStore.getState().selectedIds]).toEqual(['0'])
    useUninstallerStore.getState().toggleSelected('0')
    expect(useUninstallerStore.getState().selectedIds.size).toBe(0)
  })

  it('allows clearing a protected component left in stale selection state', () => {
    useUninstallerStore.setState({ selectedIds: new Set(['1']) })
    useUninstallerStore.getState().toggleSelected('1')
    expect(useUninstallerStore.getState().selectedIds.size).toBe(0)
  })

  it('returns to All when removing the last program with launch evidence', () => {
    const store = useUninstallerStore.getState()
    store.setPrograms([
      { ...programs[0], lastUsed: 1 },
      { ...programs[1], lastUsed: 0 }
    ])
    store.setFilterMode('no-recent-launch')
    store.removeProgram('0')
    expect(useUninstallerStore.getState().filterMode).toBe('all')
    expect(useUninstallerStore.getState().programs.map((p) => p.id)).toEqual(['1'])
  })

  it('returns to All when a refresh loses launch evidence', () => {
    const store = useUninstallerStore.getState()
    store.setPrograms([{ ...programs[0], lastUsed: 1 }])
    store.setFilterMode('no-recent-launch')
    store.setPrograms([{ ...programs[0], lastUsed: -1 }])
    expect(useUninstallerStore.getState().filterMode).toBe('all')
  })

  it('preserves the chosen filter while launch evidence remains', () => {
    const store = useUninstallerStore.getState()
    const withHistory = programs.map((p) => ({ ...p, lastUsed: 1 }))
    store.setPrograms(withHistory)
    store.setFilterMode('no-recent-launch')
    store.removeProgram('0')
    expect(useUninstallerStore.getState().filterMode).toBe('no-recent-launch')
    store.setPrograms(withHistory)
    expect(useUninstallerStore.getState().filterMode).toBe('no-recent-launch')
  })
})
