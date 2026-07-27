import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks ──

const { mockExecFile, mockExecNative } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockExecNative: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}))

vi.mock('child_process', () => {
  const execFile = (...args: unknown[]): unknown => mockExecFile(...args)
  // promisify(execFile) must yield { stdout, stderr } like the real one does.
  ;(execFile as unknown as Record<symbol, unknown>)[
    Symbol.for('nodejs.util.promisify.custom')
  ] = (...args: unknown[]): unknown => mockExecFile(...args)
  return { execFile }
})

vi.mock('../services/exec-utf8', () => ({
  psUtf8: (cmd: string) => cmd,
  execNativeUtf8: (...args: unknown[]) => mockExecNative(...args),
}))

import {
  parseEnumDrivers,
  driverIdentityKey,
  findSupersededDrivers,
  scanDrivers,
  cleanDrivers,
} from './driver-manager.ipc'
import type { RawDriver } from './driver-manager.ipc'

const originalPlatform = process.platform

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

// ── Fixtures ──

function driver(over: Partial<RawDriver> & { publishedName: string }): RawDriver {
  return {
    originalName: over.publishedName,
    provider: 'Contoso',
    className: 'Unknown',
    version: '1.0.0.0',
    date: '01/01/2024',
    signer: '',
    ...over,
  }
}

/** Tailscale's tunnel adapter: installed and working, but no device is bound while the tunnel is down. */
const WINTUN = driver({
  publishedName: 'oem12.inf',
  originalName: 'wintun.inf',
  provider: 'Tailscale Inc.',
  className: 'Network adapters',
  version: '0.14.1',
})

/** A second, unrelated driver from the same vendor in the same class. */
const TAILSCALE_TAP = driver({
  publishedName: 'oem13.inf',
  originalName: 'tailscale-tap.inf',
  provider: 'Tailscale Inc.',
  className: 'Network adapters',
  version: '1.2.0',
})

/** Renders a driver as a pnputil `-e` block. */
function enumBlock(d: RawDriver): string {
  return [
    `Published Name:     ${d.publishedName}`,
    `Original Name:      ${d.originalName}`,
    `Provider Name:      ${d.provider}`,
    `Class Name:         ${d.className}`,
    `Driver Date:        ${d.date}`,
    `Driver Version:     ${d.version}`,
    `Signer Name:        ${d.signer}`,
  ].join('\n')
}

function enumOutput(drivers: RawDriver[]): string {
  return `Microsoft PnP Utility\n\n${drivers.map(enumBlock).join('\n\n')}\n`
}

/**
 * Route the two PowerShell queries scanDrivers makes: the DriverDatabase
 * registry read (OEM → FileRepository folders) and the bound-driver query.
 */
function stubPowerShell(activeInfNames: string[]): void {
  mockExecFile.mockImplementation(async (_file: string, args: string[]) => {
    const script = args.join(' ')
    if (script.includes('Win32_PnPSignedDriver')) {
      return { stdout: activeInfNames.join('\n'), stderr: '' }
    }
    // DriverInfFiles registry read — no folder mapping needed for these tests.
    return { stdout: '', stderr: '' }
  })
}

beforeEach(() => {
  mockExecFile.mockReset()
  mockExecNative.mockReset()
  setPlatform('win32')
})

afterEach(() => {
  setPlatform(originalPlatform)
})

// ── parseEnumDrivers ──

describe('parseEnumDrivers', () => {
  it('extracts the original INF name', () => {
    const [d] = parseEnumDrivers(enumOutput([WINTUN]))
    expect(d.publishedName).toBe('oem12.inf')
    expect(d.originalName).toBe('wintun.inf')
    expect(d.provider).toBe('Tailscale Inc.')
    expect(d.version).toBe('0.14.1')
  })

  it('falls back to the published name — never the provider — when Original Name is absent', () => {
    const stdout = [
      'Microsoft PnP Utility',
      '',
      'Published Name:     oem7.inf',
      'Driver Package Provider: Contoso Corp',
      'Class Name:         Printers',
      'Driver Version:     3.0.0',
      '',
    ].join('\n')
    const [d] = parseEnumDrivers(stdout)
    // Grouping keys off originalName; a provider shared by every package a
    // vendor ships would collapse unrelated drivers into one group.
    expect(d.originalName).toBe('oem7.inf')
    expect(d.provider).toBe('Contoso Corp')
  })

  it('splits the combined "Driver date and version" field used on Windows 11 24H2+', () => {
    const stdout = [
      'Published Name:     oem3.inf',
      'Original Name:      nvlddmkm.inf',
      'Class Name:         Display adapters',
      'Driver date and version: 07/18/2024 32.0.15.6094',
      '',
    ].join('\n')
    const [d] = parseEnumDrivers(stdout)
    expect(d.date).toBe('07/18/2024')
    expect(d.version).toBe('32.0.15.6094')
  })

  it('ignores non-OEM packages', () => {
    const stdout = 'Published Name:     usbstor.inf\nClass Name:  USB\n'
    expect(parseEnumDrivers(stdout)).toEqual([])
  })
})

// ── driverIdentityKey ──

describe('driverIdentityKey', () => {
  it('keys on the original INF name and its publisher', () => {
    expect(driverIdentityKey(WINTUN)).toBe('inf:wintun.inf|tailscale inc.')
  })

  it('gives distinct keys to different INFs from the same vendor and class', () => {
    expect(driverIdentityKey(WINTUN)).not.toBe(driverIdentityKey(TAILSCALE_TAP))
  })

  it('gives distinct keys to the same INF filename from different vendors', () => {
    // "driver.inf" and friends are filenames, not globally unique ids.
    const a = driver({ publishedName: 'oem90.inf', originalName: 'driver.inf', provider: 'Contoso' })
    const b = driver({ publishedName: 'oem91.inf', originalName: 'driver.inf', provider: 'Fabrikam' })
    expect(driverIdentityKey(a)).not.toBe(driverIdentityKey(b))
  })

  it('keys a package on itself when no original INF name is reported', () => {
    const d = driver({ publishedName: 'oem7.inf', provider: 'Contoso Corp' })
    expect(driverIdentityKey(d)).toBe('pkg:oem7.inf')
  })

  it('keys a package on itself when the publisher is unknown', () => {
    const d = driver({ publishedName: 'oem8.inf', originalName: 'foo.inf', provider: 'Unknown' })
    expect(driverIdentityKey(d)).toBe('pkg:oem8.inf')
  })
})

// ── findSupersededDrivers ──

describe('findSupersededDrivers', () => {
  it('removes an older copy that a newer, bound copy of the same INF replaced', () => {
    const old = driver({ publishedName: 'oem20.inf', originalName: 'nvlddmkm.inf', version: '31.0.15.3623' })
    const current = driver({ publishedName: 'oem21.inf', originalName: 'nvlddmkm.inf', version: '32.0.15.6094' })
    const result = findSupersededDrivers([old, current], new Set(['oem21.inf']))
    expect([...result]).toEqual(['oem20.inf'])
  })

  it('never marks the bound copy itself as superseded', () => {
    const old = driver({ publishedName: 'oem20.inf', originalName: 'nvlddmkm.inf', version: '31.0' })
    const current = driver({ publishedName: 'oem21.inf', originalName: 'nvlddmkm.inf', version: '32.0' })
    expect(findSupersededDrivers([old, current], new Set(['oem21.inf'])).has('oem21.inf')).toBe(false)
  })

  // ── Regression: issue #242 ──

  it('keeps an unbound virtual network adapter driver (#242)', () => {
    // Tailscale's Wintun adapter only exists while the tunnel is up, so its
    // driver is unbound at scan time. It is still the only copy installed.
    expect(findSupersededDrivers([WINTUN], new Set()).size).toBe(0)
  })

  it('does not treat two different INFs from one vendor and class as versions of each other (#242)', () => {
    // The old grouping key was provider + class, which made the lower-versioned
    // package look like a stale duplicate of the higher-versioned one.
    const result = findSupersededDrivers([WINTUN, TAILSCALE_TAP], new Set(['oem13.inf']))
    expect(result.size).toBe(0)
  })

  it('keeps unrelated Intel Net drivers grouped only by vendor and class', () => {
    const ethernet = driver({
      publishedName: 'oem30.inf', originalName: 'e1d68x64.inf',
      provider: 'Intel', className: 'Net', version: '12.19.2.45',
    })
    const wifi = driver({
      publishedName: 'oem31.inf', originalName: 'netwtw10.inf',
      provider: 'Intel', className: 'Net', version: '23.40.0.7',
    })
    expect(findSupersededDrivers([ethernet, wifi], new Set(['oem31.inf'])).size).toBe(0)
  })

  it('keeps both copies when no copy of the driver is bound to hardware', () => {
    // An unplugged printer or dock: two versions installed, neither bound.
    // Nothing proves either was superseded, so neither is removable.
    const old = driver({ publishedName: 'oem40.inf', originalName: 'prn.inf', version: '1.0' })
    const newer = driver({ publishedName: 'oem41.inf', originalName: 'prn.inf', version: '2.0' })
    expect(findSupersededDrivers([old, newer], new Set()).size).toBe(0)
  })

  it('keeps everything when the bound-driver query returns nothing', () => {
    // getActiveDriverNames() yields an empty set when both WMI and pnputil
    // fail. Failing to an empty stale list is the safe direction.
    const old = driver({ publishedName: 'oem40.inf', originalName: 'prn.inf', version: '1.0' })
    const newer = driver({ publishedName: 'oem41.inf', originalName: 'prn.inf', version: '2.0' })
    expect(findSupersededDrivers([old, newer], new Set()).size).toBe(0)
  })

  it('keeps copies with equal versions', () => {
    const a = driver({ publishedName: 'oem50.inf', originalName: 'foo.inf', version: '1.0.0' })
    const b = driver({ publishedName: 'oem51.inf', originalName: 'foo.inf', version: '1.0.0' })
    expect(findSupersededDrivers([a, b], new Set(['oem51.inf'])).size).toBe(0)
  })

  it('keeps copies whose versions cannot be parsed', () => {
    const a = driver({ publishedName: 'oem50.inf', originalName: 'foo.inf', version: '' })
    const b = driver({ publishedName: 'oem51.inf', originalName: 'foo.inf', version: '' })
    expect(findSupersededDrivers([a, b], new Set(['oem51.inf'])).size).toBe(0)
  })

  it('keeps a copy with no version against a bound copy that has one', () => {
    // compareVersions() reads a missing version as 0, so without an explicit
    // guard "2.0" would order above "" and delete an unverified package.
    const unknown = driver({ publishedName: 'oem52.inf', originalName: 'foo.inf', version: '' })
    const bound = driver({ publishedName: 'oem53.inf', originalName: 'foo.inf', version: '2.0' })
    expect(findSupersededDrivers([unknown, bound], new Set(['oem53.inf'])).size).toBe(0)
  })

  it('keeps a copy with a non-numeric version against a bound copy', () => {
    const unknown = driver({ publishedName: 'oem54.inf', originalName: 'foo.inf', version: 'n/a' })
    const bound = driver({ publishedName: 'oem55.inf', originalName: 'foo.inf', version: '2.0' })
    expect(findSupersededDrivers([unknown, bound], new Set(['oem55.inf'])).size).toBe(0)
  })

  it('does not anchor on a bound copy whose version cannot be read', () => {
    const old = driver({ publishedName: 'oem56.inf', originalName: 'foo.inf', version: '1.0' })
    const bound = driver({ publishedName: 'oem57.inf', originalName: 'foo.inf', version: '' })
    expect(findSupersededDrivers([old, bound], new Set(['oem57.inf'])).size).toBe(0)
  })

  it('does not remove a copy that is newer than the bound one', () => {
    const staged = driver({ publishedName: 'oem60.inf', originalName: 'foo.inf', version: '3.0' })
    const bound = driver({ publishedName: 'oem61.inf', originalName: 'foo.inf', version: '2.0' })
    expect(findSupersededDrivers([staged, bound], new Set(['oem61.inf'])).size).toBe(0)
  })

  it('anchors on the newest bound copy when several are bound', () => {
    const oldest = driver({ publishedName: 'oem70.inf', originalName: 'foo.inf', version: '1.0' })
    const middle = driver({ publishedName: 'oem71.inf', originalName: 'foo.inf', version: '2.0' })
    const newest = driver({ publishedName: 'oem72.inf', originalName: 'foo.inf', version: '3.0' })
    const result = findSupersededDrivers([oldest, middle, newest], new Set(['oem71.inf', 'oem72.inf']))
    expect([...result]).toEqual(['oem70.inf'])
  })

  it('never groups packages that report no original INF name', () => {
    const a = driver({ publishedName: 'oem80.inf', provider: 'Contoso', className: 'Net', version: '1.0' })
    const b = driver({ publishedName: 'oem81.inf', provider: 'Contoso', className: 'Net', version: '2.0' })
    expect(findSupersededDrivers([a, b], new Set(['oem81.inf'])).size).toBe(0)
  })

  it('does not treat one vendor\'s INF as a version of another vendor\'s same-named INF', () => {
    const contoso = driver({
      publishedName: 'oem90.inf', originalName: 'driver.inf',
      provider: 'Contoso', className: 'Net', version: '1.0',
    })
    const fabrikam = driver({
      publishedName: 'oem91.inf', originalName: 'driver.inf',
      provider: 'Fabrikam', className: 'Net', version: '2.0',
    })
    expect(findSupersededDrivers([contoso, fabrikam], new Set(['oem91.inf'])).size).toBe(0)
  })

  it('never groups packages whose publisher is unknown', () => {
    const a = driver({ publishedName: 'oem92.inf', originalName: 'foo.inf', provider: 'Unknown', version: '1.0' })
    const b = driver({ publishedName: 'oem93.inf', originalName: 'foo.inf', provider: 'Unknown', version: '2.0' })
    expect(findSupersededDrivers([a, b], new Set(['oem93.inf'])).size).toBe(0)
  })
})

// ── scanDrivers ──

describe('scanDrivers', () => {
  it('returns an empty result off Windows', async () => {
    setPlatform('linux')
    const result = await scanDrivers()
    expect(result).toEqual({ packages: [], totalStaleSize: 0, totalStaleCount: 0, totalCurrentCount: 0 })
    expect(mockExecNative).not.toHaveBeenCalled()
  })

  it('reports no stale packages for an idle Tailscale install (#242)', async () => {
    mockExecNative.mockResolvedValue({ stdout: enumOutput([WINTUN, TAILSCALE_TAP]), stderr: '' })
    stubPowerShell([]) // tunnel is down — neither adapter is present

    const result = await scanDrivers()

    expect(result.totalStaleCount).toBe(0)
    expect(result.totalCurrentCount).toBe(2)
    expect(result.packages.every((p) => p.isCurrent && !p.selected)).toBe(true)
  })

  it('pre-selects only genuinely superseded packages', async () => {
    const old = driver({ publishedName: 'oem20.inf', originalName: 'nvlddmkm.inf', provider: 'NVIDIA', className: 'Display', version: '31.0.15.3623' })
    const current = driver({ publishedName: 'oem21.inf', originalName: 'nvlddmkm.inf', provider: 'NVIDIA', className: 'Display', version: '32.0.15.6094' })
    mockExecNative.mockResolvedValue({ stdout: enumOutput([old, current, WINTUN]), stderr: '' })
    stubPowerShell(['oem21.inf'])

    const result = await scanDrivers()

    expect(result.totalStaleCount).toBe(1)
    const selected = result.packages.filter((p) => p.selected)
    expect(selected.map((p) => p.publishedName)).toEqual(['oem20.inf'])
  })

  it('reports every package as current when driver enumeration yields nothing', async () => {
    mockExecNative.mockResolvedValue({ stdout: '', stderr: '' })
    stubPowerShell([])
    const result = await scanDrivers()
    expect(result.packages).toEqual([])
  })
})

// ── cleanDrivers ──

describe('cleanDrivers', () => {
  it('refuses a driver that is bound to a device', async () => {
    stubPowerShell(['oem12.inf'])

    const result = await cleanDrivers(['oem12.inf'])

    expect(result.removed).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.errors[0].reason).toMatch(/in use/i)
    expect(mockExecNative).not.toHaveBeenCalledWith('pnputil', ['/delete-driver', 'oem12.inf'], expect.anything())
  })

  it('rejects names that are not oem*.inf packages', async () => {
    stubPowerShell([])

    const result = await cleanDrivers(['..\\..\\windows\\system32\\drivers\\tcpip.sys'])

    expect(result.failed).toBe(1)
    expect(result.errors[0].reason).toBe('Invalid driver package name')
    expect(mockExecNative).not.toHaveBeenCalled()
  })

  it('removes an unbound package', async () => {
    stubPowerShell(['oem21.inf'])
    mockExecNative.mockResolvedValue({ stdout: '', stderr: '' })

    const result = await cleanDrivers(['oem20.inf'])

    expect(result.removed).toBe(1)
    expect(result.failed).toBe(0)
    expect(mockExecNative).toHaveBeenCalledWith('pnputil', ['/delete-driver', 'oem20.inf'], expect.anything())
  })

  it('returns an empty result off Windows', async () => {
    setPlatform('linux')
    const result = await cleanDrivers(['oem20.inf'])
    expect(result).toEqual({ removed: 0, failed: 0, spaceRecovered: 0, errors: [] })
  })
})
