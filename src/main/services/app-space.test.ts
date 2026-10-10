import { describe, it, expect } from 'vitest'
import { join } from 'path'
import {
  buildAppSpaceEntries,
  uniqueAppSpaceMeasurements,
  type AppSpaceMeasurement
} from './app-space'
import type { InstalledProgram } from '../../shared/types'
const program = (id: string, name: string, estimatedSize = 200): InstalledProgram => ({
  id,
  displayName: name,
  publisher: '',
  estimatedSize,
  displayVersion: '',
  installDate: '',
  installLocation: '',
  uninstallString: '',
  quietUninstallString: '',
  displayIcon: '',
  registryKey: '',
  isSystemComponent: false,
  isWindowsInstaller: false,
  lastUsed: -1
})
const measure = (
  id: string,
  name: string,
  paths: Array<[string, number]>
): AppSpaceMeasurement => ({
  id,
  name,
  category: 'app',
  result: {
    category: 'app',
    subcategory: name,
    totalSize: 0,
    itemCount: paths.length,
    items: paths.map(([path, size], i) => ({
      id: `${id}:${i}`,
      path,
      size,
      category: 'app',
      subcategory: name,
      lastModified: 0,
      selected: true
    }))
  }
})
describe('App Space attribution', () => {
  it('matches only exact unique product identities, never loose names', () => {
    const entries = buildAppSpaceEntries(
      [program('a', 'Discord Canary'), program('b', 'Discord')],
      [measure('discord', 'Discord', [[join('cache', 'discord'), 100]])]
    )
    expect(entries.find((entry) => entry.programId === 'b')?.cacheBytes).toBe(100)
    expect(entries.find((entry) => entry.programId === 'a')?.cacheBytes).toBe(0)
  })
  it('keeps ambiguous installations separate from known cache owners', () => {
    const entries = buildAppSpaceEntries(
      [program('a', 'Slack'), program('b', 'Slack')],
      [measure('slack', 'Slack', [[join('cache', 'slack'), 100]])]
    )
    expect(entries.find((entry) => entry.id === 'rule:Slack')?.cacheBytes).toBe(100)
    expect(
      entries.filter((entry) => entry.programId).every((entry) => entry.cacheBytes === 0)
    ).toBe(true)
  })
  it('does not multiply totals when a browser has multiple profiles and targets', () => {
    const entries = buildAppSpaceEntries(
      [program('chrome', 'Google Chrome')],
      [
        measure('browser:chrome', 'Chrome', [[join('profile1', 'Cache'), 100]]),
        measure('browser:chrome', 'Chrome', [[join('profile2', 'Cache'), 250]])
      ]
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].cacheBytes).toBe(350)
    expect(entries[0].cacheItems).toBe(2)
    expect(entries[0].rules).toHaveLength(1)
  })
  it('deduplicates shared and nested scan entries without suppressing similar siblings', () => {
    const entries = buildAppSpaceEntries(
      [],
      [
        measure('first', 'Shared', [
          [join('cache', 'root', 'child'), 40],
          [join('cache', 'root2'), 20]
        ]),
        measure('second', 'Shared', [
          [join('cache', 'root'), 100],
          [join('cache', 'root2'), 20]
        ])
      ]
    )
    expect(entries.reduce((sum, entry) => sum + entry.cacheBytes, 0)).toBe(120)
  })
  it('deduplicates a wide cache in the same way for overview and cleanup handoff', () => {
    const paths: Array<[string, number]> = Array.from({ length: 20000 }, (_, index) => [
      join('wide-cache', `file-${index}`),
      5
    ])
    const measurements = [
      measure('cache', 'Cache', paths),
      measure('cache', 'Cache', paths.slice(0, 100))
    ]
    expect(buildAppSpaceEntries([], measurements)[0].cacheBytes).toBe(100000)
    const results = uniqueAppSpaceMeasurements(measurements)
    expect(results.reduce((sum, result) => sum + result.result.totalSize, 0)).toBe(100000)
    expect(results.reduce((sum, result) => sum + result.result.itemCount, 0)).toBe(20000)
  })
  it('shows missing or invalid installed sizes as unknown and preserves separate estimates', () => {
    const entries = buildAppSpaceEntries(
      [program('a', 'Slack', 0), program('b', 'Discord', NaN), program('c', 'Steam', 500)],
      [measure('steam', 'Steam', [[join('cache', 'steam'), 200]])]
    )
    expect(entries.find((entry) => entry.programId === 'a')?.installedBytes).toBeNull()
    expect(entries.find((entry) => entry.programId === 'b')?.installedBytes).toBeNull()
    const steam = entries.find((entry) => entry.programId === 'c')!
    expect(steam.installedBytes).toBe(500)
    expect(steam.cacheBytes).toBe(200)
  })
})
