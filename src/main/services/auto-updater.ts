import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC } from '../../shared/channels'
import { getSettings } from './settings-store'
import type { UpdateStatus } from '../../shared/types'

let status: UpdateStatus = { state: 'idle' }
let daemonMode = false
let checkInterval: ReturnType<typeof setInterval> | null = null

function broadcast(s: UpdateStatus): void {
  status = s
  if (daemonMode) {
    const ts = new Date().toISOString()
    const detail = s.version ? ` v${s.version}` : ''
    const progress = s.progress != null ? ` ${s.progress}%` : ''
    const error = s.error ? ` — ${s.error}` : ''
    process.stdout.write(`[${ts}] [updater] ${s.state}${detail}${progress}${error}\n`)
    return
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    // isDestroyed() returns false while the render frame is mid-teardown,
    // so .send() still throws "Render frame was disposed before WebFrameMain
    // could be accessed". Swallow it — there's no recipient anyway, and the
    // unhandled stack trace was the loudest signal in issue #148, masking
    // the actual renderer crash.
    try {
      win.webContents.send(IPC.UPDATER_STATUS, s)
    } catch { /* renderer gone — nothing to deliver to */ }
  }
}

interface InitOptions {
  daemon?: boolean
}

export function initAutoUpdater(opts: InitOptions = {}): void {
  if (!app.isPackaged) return

  // On Linux, electron-updater only supports AppImage.
  // Skip if not running as an AppImage to avoid silent failures.
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    console.log('Auto-updater: skipping on Linux (not running as AppImage)')
    return
  }

  daemonMode = opts.daemon === true

  const settings = getSettings()
  autoUpdater.autoDownload = daemonMode || settings.autoUpdate
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    broadcast({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    broadcast({ state: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    broadcast({ state: 'not-available' })
  })

  autoUpdater.on('download-progress', (prog) => {
    broadcast({ state: 'downloading', progress: Math.round(prog.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    broadcast({ state: 'downloaded', version: info.version })
    if (daemonMode) {
      process.stdout.write(`[${new Date().toISOString()}] [updater] Installing v${info.version} and restarting...\n`)
      autoUpdater.quitAndInstall(true, true)
      return
    }
    // GUI mode: auto-restart if the user opted in
    const current = getSettings()
    if (current.autoRestart) {
      console.log(`Auto-updater: auto-restart enabled, installing v${info.version} and restarting...`)
      autoUpdater.quitAndInstall(true, true)
    }
  })

  autoUpdater.on('error', (err) => {
    broadcast({ state: 'error', error: err?.message || 'Update failed' })
  })

  // Check on startup
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('Auto-updater check failed:', err?.message || err)
  })

  // Periodic background checks
  startPeriodicChecks(settings.updateCheckIntervalHours)
}

function startPeriodicChecks(intervalHours: number): void {
  if (checkInterval) clearInterval(checkInterval)
  if (intervalHours <= 0) return
  const ms = intervalHours * 60 * 60 * 1000
  checkInterval = setInterval(() => {
    const settings = getSettings()
    autoUpdater.autoDownload = daemonMode || settings.autoUpdate
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('Auto-updater periodic check failed:', err?.message || err)
    })
  }, ms)
}

/** Call when the user changes updateCheckIntervalHours at runtime */
export function updateCheckInterval(hours: number): void {
  if (!app.isPackaged) return
  startPeriodicChecks(hours)
}

export function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) return Promise.resolve()
  return autoUpdater.checkForUpdates().then(() => {})
}

export function downloadUpdate(): Promise<void> {
  if (!app.isPackaged) return Promise.resolve()
  return autoUpdater.downloadUpdate().then(() => {})
}

export function installUpdate(): void {
  if (!app.isPackaged) return
  autoUpdater.quitAndInstall(true, true)
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

export function setAutoDownload(enabled: boolean): void {
  if (app.isPackaged) {
    autoUpdater.autoDownload = enabled
  }
}
