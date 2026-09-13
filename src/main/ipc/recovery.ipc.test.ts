import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC } from '../../shared/channels'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  openPath: vi.fn(async () => ''),
  backupDir: 'C:/kudu-test/Kudu Backups'
}))

vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }
  },
  shell: { openPath: mocks.openPath }
}))

vi.mock('fs/promises', () => ({
  mkdir: mocks.mkdir,
  readdir: vi.fn(),
  lstat: vi.fn(),
  writeFile: vi.fn()
}))

vi.mock('../services/backup-dir', () => ({ getBackupDir: () => mocks.backupDir }))
vi.mock('../services/recovery-store', () => ({
  listRecoveryEntries: vi.fn(),
  listRecoveryPage: vi.fn(),
  removeRecoveryEntry: vi.fn()
}))
vi.mock('../services/recovery', () => ({ restoreRecoveryEntry: vi.fn() }))
vi.mock('./game-mode.ipc', () => ({ getGameModeStatus: vi.fn() }))

import { registerRecoveryIpc } from './recovery.ipc'

describe('RECOVERY_OPEN_BACKUPS', () => {
  beforeEach(() => {
    handlers.clear()
    mocks.mkdir.mockClear()
    mocks.openPath.mockClear()
    mocks.openPath.mockResolvedValue('')
    registerRecoveryIpc()
  })

  it('creates the backup folder before opening it', async () => {
    await handlers.get(IPC.RECOVERY_OPEN_BACKUPS)!({})

    expect(mocks.mkdir).toHaveBeenCalledWith(mocks.backupDir, { recursive: true })
    expect(mocks.openPath).toHaveBeenCalledWith(mocks.backupDir)
    expect(mocks.mkdir.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.openPath.mock.invocationCallOrder[0]
    )
  })

  it('surfaces a non-empty openPath result as an error', async () => {
    mocks.openPath.mockResolvedValue('No application found')

    await expect(handlers.get(IPC.RECOVERY_OPEN_BACKUPS)!({})).rejects.toThrow(
      'No application found'
    )
  })
})
