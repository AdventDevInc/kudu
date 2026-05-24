/**
 * Helpers for persisting the user's "ignore this tweak" choices in the
 * Registry Cleaner (issue #172).
 *
 * The registry scan regenerates its entries on every run with a fresh random
 * `id`, so we can't remember a user's de-selection by id. Instead we key on a
 * stable signature derived from what the fix actually changes — the registry
 * key path and value name. When a user unticks one of these recurring advisory
 * tweaks (e.g. "disable SysMain"), we persist its signature so the box isn't
 * re-ticked on the next scan/restart.
 *
 * Only recurring *advisory* recommendations are remembered. Transient
 * junk-cleanup rows (obsolete / invalid / orphaned / broken keys) keep their
 * per-session behaviour — they point at one-off paths and would only bloat the
 * ignore list.
 */

import type { RegistryEntry } from './types'

/** Entry types that represent recurring, deterministic recommendations. */
export const PERSISTENT_TWEAK_TYPES: ReadonlySet<RegistryEntry['type']> = new Set([
  'vulnerability',
  'privacy',
  'performance',
  'network',
  'service',
  'task',
])

/** Whether a scan entry's de-selection should be remembered across restarts. */
export function isPersistentTweak(type: RegistryEntry['type']): boolean {
  return PERSISTENT_TWEAK_TYPES.has(type)
}

/**
 * Stable identity for a tweak, independent of the random per-scan `id`.
 * Registry paths are case-insensitive on Windows, so we normalise to lowercase.
 */
export function tweakSignature(entry: Pick<RegistryEntry, 'keyPath' | 'valueName'>): string {
  return `${(entry.keyPath ?? '').toLowerCase()}|${(entry.valueName ?? '').toLowerCase()}`
}

/**
 * De-select any advisory tweak the user has previously chosen to ignore so it
 * is never pre-ticked (and therefore can't be applied accidentally). Mutates
 * and returns the same array. Non-advisory entries are left untouched.
 */
export function applyIgnoredTweaks<
  T extends Pick<RegistryEntry, 'type' | 'keyPath' | 'valueName' | 'selected'>
>(entries: T[], ignored: ReadonlySet<string> | readonly string[]): T[] {
  const set = ignored instanceof Set ? ignored : new Set(ignored)
  if (set.size === 0) return entries
  for (const entry of entries) {
    if (isPersistentTweak(entry.type) && set.has(tweakSignature(entry))) {
      entry.selected = false
    }
  }
  return entries
}
