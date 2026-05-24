import { describe, it, expect } from 'vitest'
import {
  isPersistentTweak,
  tweakSignature,
  applyIgnoredTweaks,
  PERSISTENT_TWEAK_TYPES,
} from './registry-tweaks'
import type { RegistryEntry } from './types'

function entry(over: Partial<RegistryEntry>): RegistryEntry {
  return {
    id: Math.random().toString(36).slice(2),
    type: 'performance',
    keyPath: 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\SysMain',
    valueName: 'Start',
    issue: 'SysMain enabled',
    risk: 'low',
    selected: true,
    ...over,
  }
}

describe('isPersistentTweak', () => {
  it('remembers advisory recommendation types', () => {
    for (const t of ['vulnerability', 'privacy', 'performance', 'network', 'service', 'task'] as const) {
      expect(isPersistentTweak(t)).toBe(true)
    }
  })

  it('does not remember transient junk-cleanup types', () => {
    for (const t of ['obsolete', 'invalid', 'orphaned', 'broken'] as const) {
      expect(isPersistentTweak(t)).toBe(false)
    }
  })
})

describe('tweakSignature', () => {
  it('is independent of the random per-scan id', () => {
    expect(tweakSignature(entry({ id: 'a' }))).toBe(tweakSignature(entry({ id: 'b' })))
  })

  it('is case-insensitive (registry paths are case-insensitive on Windows)', () => {
    const upper = tweakSignature({ keyPath: 'HKLM\\Foo\\Bar', valueName: 'Start' })
    const lower = tweakSignature({ keyPath: 'hklm\\foo\\bar', valueName: 'start' })
    expect(upper).toBe(lower)
  })

  it('distinguishes different key paths and value names', () => {
    const sysmain = tweakSignature({ keyPath: 'HKLM\\...\\SysMain', valueName: 'Start' })
    const llmnr = tweakSignature({ keyPath: 'HKLM\\...\\DNSClient', valueName: 'EnableMulticast' })
    expect(sysmain).not.toBe(llmnr)
  })
})

describe('applyIgnoredTweaks (issue #172)', () => {
  it('de-selects an advisory tweak the user previously ignored', () => {
    const sysmain = entry({ selected: true })
    const ignored = [tweakSignature(sysmain)]
    applyIgnoredTweaks([sysmain], ignored)
    expect(sysmain.selected).toBe(false)
  })

  it('leaves non-ignored tweaks pre-selected', () => {
    const llmnr = entry({ type: 'vulnerability', keyPath: 'HKLM\\X\\DNSClient', valueName: 'EnableMulticast', selected: true })
    applyIgnoredTweaks([llmnr], ['hklm\\system\\currentcontrolset\\services\\sysmain|start'])
    expect(llmnr.selected).toBe(true)
  })

  it('never touches transient junk-cleanup rows even on a signature match', () => {
    const junk = entry({ type: 'obsolete', selected: true })
    // Same signature as an ignored SysMain entry, but a junk type — must stay selected.
    applyIgnoredTweaks([junk], [tweakSignature(junk)])
    expect(junk.selected).toBe(true)
  })

  it('is a no-op when nothing is ignored', () => {
    const e = entry({ selected: true })
    applyIgnoredTweaks([e], [])
    expect(e.selected).toBe(true)
  })

  it('accepts a Set as well as an array', () => {
    const e = entry({ selected: true })
    applyIgnoredTweaks([e], new Set([tweakSignature(e)]))
    expect(e.selected).toBe(false)
  })
})

describe('PERSISTENT_TWEAK_TYPES', () => {
  it('does not include junk-cleanup types', () => {
    expect(PERSISTENT_TWEAK_TYPES.has('obsolete')).toBe(false)
  })
})
