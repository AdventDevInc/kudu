import { describe, expect, it } from 'vitest'
import { canBatchUninstall, getSharedComponentKind, hasNoRecentLaunch } from './uninstall-policy'

const now = Date.UTC(2026, 8, 27)
const day = 86400000
const app = { displayName: 'Disk Drill', isSystemComponent: false }

describe('launch history classification', () => {
  it.each([-1, 0, NaN, Infinity, now + day, now, now - 90 * day])(
    'does not recommend removal based on unknown, invalid or recent history (%s)',
    (lastUsed) => expect(hasNoRecentLaunch({ ...app, lastUsed }, now)).toBe(false)
  )

  it('includes an ordinary application with a detected launch older than 90 days', () => {
    expect(hasNoRecentLaunch({ ...app, lastUsed: now - 91 * day }, now)).toBe(true)
  })
})

describe('local shared component protection', () => {
  it.each([
    ['Dokan Library 2.0.6.1000 (x64)', 'filesystem'],
    ['Dokan', 'filesystem'],
    ['Dokany 1.5', 'filesystem'],
    ['WinFsp 2025', 'filesystem'],
    ['  DOKAN Library 1.5.1  ', 'filesystem'],
    ['Microsoft Visual C++ 2015-2022 Redistributable (x64)', 'runtime'],
    ['Microsoft Visual C++ 2022 X64 Minimum Runtime - 14.40', 'runtime'],
    ['Microsoft .NET Framework 4.8', 'runtime'],
    ['Microsoft .NET Runtime - 8.0.1 (x64)', 'runtime'],
    ['Microsoft .NET Core Runtime - 3.1.32 (x64)', 'runtime'],
    ['Microsoft .NET Host FX Resolver - 8.0.1 (x64)', 'runtime'],
    ['Microsoft Windows Desktop Runtime - 8.0.1 (x64)', 'runtime'],
    ['Microsoft ASP.NET Core 8.0.1 Shared Framework (x64)', 'runtime'],
    ['Microsoft Edge WebView2 Runtime', 'runtime'],
    ['Java 8 Update 401 (64-bit)', 'runtime'],
    ['Java(TM) 6 Update 45', 'runtime'],
    ['Eclipse Temurin JRE with Hotspot 17.0.1', 'runtime'],
    ['Amazon Corretto 21', 'runtime'],
    ['OpenJDK 21', 'runtime'],
    ['NVIDIA Graphics Driver 580.88', 'driver'],
    ['Realtek Ethernet Controller Driver', 'driver']
  ])('protects %s without cloud ratings or launch history', (displayName, kind) => {
    const program = { ...app, displayName, lastUsed: now - 365 * day }
    expect(getSharedComponentKind(program)).toBe(kind)
    expect(canBatchUninstall(program)).toBe(false)
    expect(hasNoRecentLaunch(program, now)).toBe(false)
  })

  it.each([
    'Disk Drill',
    'Firefox',
    'Microsoft Visual Studio Code',
    'Microsoft Edge',
    'Dokanizer',
    'JavaScript Editor'
  ])('keeps ordinary apps selectable: %s', (displayName) => {
    expect(canBatchUninstall({ ...app, displayName })).toBe(true)
  })

  it('protects explicitly marked system components regardless of name', () => {
    expect(getSharedComponentKind({ ...app, isSystemComponent: true })).toBe('system')
  })
})
