import { describe, it, expect } from 'vitest'
import { IPC } from './channels'
import { CleanerType, ScanStatus } from './enums'

describe('IPC channels', () => {
  it('exports an IPC object with string values', () => {
    expect(typeof IPC).toBe('object')
    const values = Object.values(IPC)
    expect(values.length).toBeGreaterThan(0)
    for (const val of values) {
      expect(typeof val).toBe('string')
    }
  })

  it('has no duplicate channel values', () => {
    const values = Object.values(IPC)
    const unique = new Set(values)
    expect(unique.size).toBe(values.length)
  })

  it('all channel values use colon-separated namespacing', () => {
    for (const val of Object.values(IPC)) {
      expect(val).toMatch(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)*$/)
    }
  })

  it('has expected core channels', () => {
    expect(IPC.SYSTEM_SCAN).toBe('cleaner:system:scan')
    expect(IPC.SYSTEM_CLEAN).toBe('cleaner:system:clean')
    expect(IPC.SETTINGS_GET).toBe('settings:get')
    expect(IPC.SETTINGS_SET).toBe('settings:set')
    expect(IPC.HISTORY_GET).toBe('history:get')
    expect(IPC.HISTORY_ADD).toBe('history:add')
    expect(IPC.HISTORY_CLEAR).toBe('history:clear')
  })
})

describe('CleanerType enum', () => {
  it('has expected values', () => {
    expect(CleanerType.System).toBe('system')
    expect(CleanerType.Browser).toBe('browser')
    expect(CleanerType.App).toBe('app')
    expect(CleanerType.Gaming).toBe('gaming')
    expect(CleanerType.RecycleBin).toBe('recycleBin')
    expect(CleanerType.UninstallLeftovers).toBe('uninstallLeftovers')
    expect(CleanerType.Shortcut).toBe('shortcut')
    expect(CleanerType.Database).toBe('database')
    expect(CleanerType.Environment).toBe('environment')
  })

  it('has exactly 9 members', () => {
    const keys = Object.keys(CleanerType).filter((k) => isNaN(Number(k)))
    expect(keys).toHaveLength(9)
  })
})

describe('ScanStatus enum', () => {
  it('has expected values', () => {
    expect(ScanStatus.Idle).toBe('idle')
    expect(ScanStatus.Scanning).toBe('scanning')
    expect(ScanStatus.Complete).toBe('complete')
    expect(ScanStatus.Cleaning).toBe('cleaning')
    expect(ScanStatus.Error).toBe('error')
  })

  it('has exactly 5 members', () => {
    const keys = Object.keys(ScanStatus).filter((k) => isNaN(Number(k)))
    expect(keys).toHaveLength(5)
  })
})
