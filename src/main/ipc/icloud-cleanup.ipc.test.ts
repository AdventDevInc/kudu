import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  external: vi.fn(),
  open: vi.fn(async () => ''),
  scan: vi.fn(async () => ({ items: [] })),
  remove: vi.fn(),
  present: new Set<string>()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, callback: any) => mocks.handlers.set(name, callback) },
  shell: { openExternal: mocks.external, openPath: mocks.open, trashItem: vi.fn() }
}))
vi.mock('fs/promises', () => ({
  access: async (path: string) => {
    if (!mocks.present.has(path)) throw Object.assign(new Error('Not found'), { code: 'ENOENT' })
  }
}))
vi.mock('../services/device-backups', () => ({
  DeviceBackups: class {
    scan = mocks.scan
    remove = mocks.remove
  }
}))
import { registerICloudCleanupIpc } from './icloud-cleanup.ipc'
import { IPC } from '../../shared/channels'
import { ICLOUD_SERVICES } from '../../shared/icloud-cleanup'

describe.skipIf(process.platform !== 'darwin')('iCloud management IPC', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    vi.clearAllMocks()
    mocks.present.clear()
    registerICloudCleanupIpc()
  })
  it('lists a unique service catalog and reports actual application availability', async () => {
    expect(new Set(ICLOUD_SERVICES.map((service) => service.id)).size).toBe(ICLOUD_SERVICES.length)
    mocks.present.add('/System/Applications/Photos.app')
    const result = await mocks.handlers.get(IPC.ICLOUD_SERVICES)!(null)
    expect(result).toHaveLength(32)
    expect(result.find((item: any) => item.id === 'photos').canOpenApp).toBe(true)
    expect(result.find((item: any) => item.id === 'notes').canOpenApp).toBe(false)
  })
  it('opens only predefined settings and help destinations', async () => {
    const handler = mocks.handlers.get(IPC.ICLOUD_OPEN)!
    await handler(null, 'settings')
    expect(mocks.external).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preferences.AppleIDPrefPane?iCloud'
    )
    await handler(null, 'guide')
    expect(mocks.external).toHaveBeenCalledWith('https://support.apple.com/108922')
    await expect(handler(null, 'https://untrusted.example')).rejects.toThrow('Unknown')
    await expect(handler(null, 'app', '../../anything')).rejects.toThrow('Unknown')
  })
  it('opens only catalog applications found in the allowed application folders', async () => {
    mocks.present.add('/System/Applications/Photos.app')
    const handler = mocks.handlers.get(IPC.ICLOUD_OPEN)!
    await handler(null, 'app', 'photos')
    expect(mocks.open).toHaveBeenCalledWith('/System/Applications/Photos.app')
    await expect(handler(null, 'app', 'notes')).rejects.toThrow('not found')
  })
  it('passes scoped selections and acknowledgments to the backup service', async () => {
    await mocks.handlers.get(IPC.DEVICE_BACKUPS_REMOVE)!(null, 'scan', ['item'], 'DELETE', true)
    expect(mocks.remove).toHaveBeenCalledWith('scan', ['item'], 'DELETE', true)
    await mocks.handlers.get(IPC.DEVICE_BACKUPS_SCAN)!(null)
    expect(mocks.scan).toHaveBeenCalled()
  })
})
