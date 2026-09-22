import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriverUpdate } from '../shared/types'

const mocks = vi.hoisted(() => ({
  scanDriverUpdates: vi.fn(),
  installDriverUpdates: vi.fn(),
  setDriverUpdateIgnored: vi.fn()
}))
vi.mock('./ipc/driver-manager.ipc', () => ({
  scanDrivers: vi.fn(),
  cleanDrivers: vi.fn(),
  scanDriverUpdates: mocks.scanDriverUpdates,
  installDriverUpdates: mocks.installDriverUpdates,
  setDriverUpdateIgnored: mocks.setDriverUpdateIgnored
}))

import { handleDrivers, ExitCode } from './cli'

const ctx = { json: true, verbosity: 'quiet' as const }

function upd(updateId: string, isHidden = false): DriverUpdate {
  return {
    id: updateId,
    updateId,
    deviceName: `Device ${updateId}`,
    deviceId: '',
    className: 'Keyboard',
    currentVersion: '1.0',
    currentDate: '',
    availableVersion: '2.0',
    availableDate: '',
    provider: 'Lenovo',
    updateTitle: `Lenovo - Keyboard - ${updateId}`,
    downloadSize: '',
    selected: true,
    isHidden
  }
}

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  mocks.scanDriverUpdates.mockReset().mockResolvedValue({
    updates: [upd('offered')],
    ignoredUpdates: [upd('ignored', true)],
    totalAvailable: 1,
    scanDuration: 0,
    updatesDisabled: false
  })
  mocks.installDriverUpdates
    .mockReset()
    .mockResolvedValue({ installed: 1, failed: 0, rebootRequired: false, errors: [] })
  mocks.setDriverUpdateIgnored.mockReset().mockResolvedValue({ windowsUpdateHidden: true })
})
afterEach(() => vi.restoreAllMocks())

describe('drivers CLI ignore list (#464)', () => {
  it('installs an explicitly named offered update', async () => {
    await handleDrivers(['update', 'offered'], ctx)
    expect(mocks.installDriverUpdates).toHaveBeenCalledWith(['offered'], expect.any(Function))
  })

  it('refuses to install an ignored update by explicit ID', async () => {
    expect(await handleDrivers(['update', 'ignored'], ctx)).toBe(ExitCode.INVALID_ARGS)
    expect(mocks.installDriverUpdates).not.toHaveBeenCalled()
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('"ignored"'))
  })

  it('refuses to install an ID that is not offered at all', async () => {
    expect(await handleDrivers(['update', 'offered,bogus'], ctx)).toBe(ExitCode.INVALID_ARGS)
    expect(mocks.installDriverUpdates).not.toHaveBeenCalled()
  })

  it('--all never includes ignored updates', async () => {
    await handleDrivers(['update', '--all'], ctx)
    expect(mocks.installDriverUpdates).toHaveBeenCalledWith(['offered'], expect.any(Function))
  })

  it('ignore/unignore forward each ID with the right flag', async () => {
    await handleDrivers(['ignore', 'a,b'], ctx)
    expect(mocks.setDriverUpdateIgnored.mock.calls).toEqual([
      ['a', true],
      ['b', true]
    ])
    mocks.setDriverUpdateIgnored.mockClear()
    await handleDrivers(['unignore', 'a'], ctx)
    expect(mocks.setDriverUpdateIgnored).toHaveBeenCalledWith('a', false)
  })

  it('ignore without an ID is a usage error', async () => {
    expect(await handleDrivers(['ignore'], ctx)).toBe(ExitCode.INVALID_ARGS)
    expect(mocks.setDriverUpdateIgnored).not.toHaveBeenCalled()
  })
})
