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
})
