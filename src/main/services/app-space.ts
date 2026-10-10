import { dirname, normalize, resolve } from 'path'
import type { AppSpaceEntry, InstalledProgram, ScanResult } from '../../shared/types'

export interface AppSpaceMeasurement {
  id: string
  name: string
  category: string
  result: ScanResult
}
const identity = (name: string): string => name.trim().toLocaleLowerCase('en-US')
// Explicit product names only: versions, publishers and partial matches are never stripped.
const aliases: Record<string, string[]> = {
  'VS Code': ['Microsoft Visual Studio Code', 'Microsoft Visual Studio Code (User)'],
  Chrome: ['Google Chrome'],
  Edge: ['Microsoft Edge'],
  Firefox: ['Mozilla Firefox'],
  'Steam Launcher': ['Steam']
}
const pathKey = (path: string): string => {
  const value = normalize(resolve(path))
  return process.platform === 'win32' ? value.toLowerCase() : value
}

export function uniqueAppSpaceMeasurements(
  measurements: AppSpaceMeasurement[]
): AppSpaceMeasurement[] {
  const owned = new Set<string>()
  const ordered = measurements
    .flatMap((measurement, index) =>
      measurement.result.items.map((item) => ({ index, item, key: pathKey(item.path) }))
    )
    .sort((a, b) => a.key.length - b.key.length)
  const kept = measurements.map(() => [] as ScanResult['items'])
  for (const { index, item, key } of ordered) {
    let ancestor = key
    let duplicate = false
    while (true) {
      if (owned.has(ancestor)) {
        duplicate = true
        break
      }
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
    if (duplicate) continue
    owned.add(key)
    kept[index].push(item)
  }
  return measurements.map((measurement, index) => ({
    ...measurement,
    result: {
      ...measurement.result,
      items: kept[index],
      itemCount: kept[index].length,
      totalSize: kept[index].reduce(
        (sum, item) => sum + (Number.isFinite(item.size) ? Math.max(0, item.size) : 0),
        0
      )
    }
  }))
}

export function buildAppSpaceEntries(
  programs: InstalledProgram[],
  measurements: AppSpaceMeasurement[]
): AppSpaceEntry[] {
  const entries: AppSpaceEntry[] = programs.map((program) => ({
    id: `program:${program.id}`,
    name: program.displayName,
    publisher: program.publisher,
    installedBytes:
      Number.isFinite(program.estimatedSize) && program.estimatedSize > 0
        ? program.estimatedSize
        : null,
    programId: program.id,
    cacheBytes: 0,
    cacheItems: 0,
    rules: []
  }))
  const unique = new Map<string, { bytes: number; count: number }>()
  for (const measurement of uniqueAppSpaceMeasurements(measurements)) {
    const total = unique.get(measurement.id) ?? { bytes: 0, count: 0 }
    total.bytes += measurement.result.totalSize
    total.count += measurement.result.itemCount
    unique.set(measurement.id, total)
  }
  const applied = new Set<string>()
  for (const measurement of measurements) {
    if (applied.has(measurement.id)) continue
    applied.add(measurement.id)
    const total = unique.get(measurement.id)
    if (!total || total.count === 0) continue
    const names = [measurement.name, ...(aliases[measurement.name] ?? [])].map(identity)
    const matches = entries.filter(
      (entry) => entry.programId && names.includes(identity(entry.name))
    )
    let entry =
      matches.length === 1
        ? matches[0]
        : entries.find((entry) => entry.id === `rule:${measurement.name}`)
    if (!entry) {
      entry = {
        id: `rule:${measurement.name}`,
        name: measurement.name,
        publisher: '',
        installedBytes: null,
        programId: null,
        cacheBytes: 0,
        cacheItems: 0,
        rules: []
      }
      entries.push(entry)
    }
    entry.cacheBytes += total.bytes
    entry.cacheItems += total.count
    entry.rules.push({ id: measurement.id, name: measurement.name, category: measurement.category })
  }
  return entries.sort(
    (a, b) =>
      b.cacheBytes - a.cacheBytes ||
      (b.installedBytes ?? 0) - (a.installedBytes ?? 0) ||
      a.name.localeCompare(b.name)
  )
}
