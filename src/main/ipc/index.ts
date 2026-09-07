import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, isAbsolute } from 'path'
import { IPC } from '../../shared/channels'
import { psUtf8 } from '../services/exec-utf8'
import { registerSystemCleanerIpc } from './system-cleaner.ipc'
import { registerBrowserCleanerIpc } from './browser-cleaner.ipc'
import { registerAppCleanerIpc } from './app-cleaner.ipc'
import { registerGamingCleanerIpc } from './gaming-cleaner.ipc'
import { registerRecycleBinIpc } from './recycle-bin.ipc'
import { registerRegistryCleanerIpc } from './registry-cleaner.ipc'
import { registerContextMenuCleanerIpc } from './context-menu-cleaner.ipc'
import { registerStartupManagerIpc } from './startup-manager.ipc'
import { registerDebloaterIpc } from './debloater.ipc'
import { registerDiskAnalyzerIpc } from './disk-analyzer.ipc'
import { registerDiskTrimIpc } from './disk-trim.ipc'
import { registerDuplicateFinderIpc } from './duplicate-finder.ipc'
import { registerNetworkCleanupIpc } from './network-cleanup.ipc'
import { registerMalwareScannerIpc } from './malware-scanner.ipc'
import { registerPrivacyShieldIpc } from './privacy-shield.ipc'
import { registerUninstallLeftoversIpc } from './uninstall-leftovers.ipc'
import { registerDriverManagerIpc } from './driver-manager.ipc'
import { registerPerfMonitorIpc } from './perf-monitor.ipc'
import { registerProgramUninstallerIpc } from './program-uninstaller.ipc'
import { registerServiceManagerIpc } from './service-manager.ipc'
import { registerFirewallAuditIpc } from './firewall-audit.ipc'
import { registerSoftwareUpdaterIpc } from './software-updater.ipc'
import { registerShortcutCleanerIpc } from './shortcut-cleaner.ipc'
import { registerEnvironmentCleanerIpc } from './environment-cleaner.ipc'
import { showOpenDialog } from './open-dialog'
import { registerDatabaseOptimizerIpc } from './database-optimizer.ipc'
import { registerCloudAgentIpc } from './cloud-agent.ipc'
import { registerLargeFileFinderIpc } from './large-file-finder.ipc'
import { registerEmptyFolderCleanerIpc } from './empty-folder-cleaner.ipc'
import { registerFileShredderIpc } from './file-shredder.ipc'
import { registerGameModeIpc, refreshGameDetector } from './game-mode.ipc'
import { registerCveScannerIpc } from './cve-scanner.ipc'
import { registerBreachMonitorIpc } from './breach-monitor.ipc'
import { registerStartupSafetyIpc } from './startup-safety.ipc'
import { registerProgramSafetyIpc } from './program-safety.ipc'
import { getSettings, setSettings, flushSettings, getOnboardingComplete, setOnboardingComplete } from '../services/settings-store'
import { getBackupDir } from '../services/backup-dir'
import { isAdmin } from '../services/elevation'
import { getHistory, addHistoryEntry, clearHistory } from '../services/history-store'
import { getCloudHistory, clearCloudHistory } from '../services/cloud-history-store'
import {
  queryDeletions, queryAllDeletions, clearDeletionLog, getDeletionLogPath
} from '../services/deletion-log-store'
import { validateSettingsPartial, validateHistoryEntry, validateDeletionQuery } from '../services/ipc-validation'
import { createRestorePoint } from '../services/restore-point'
import { checkForUpdates, downloadUpdate, installUpdate, getUpdateStatus, setAutoDownload, updateCheckInterval } from '../services/auto-updater'
import { buildLinuxElevationCommand, getLinuxRelaunchExecutable } from '../platform/linux/elevation'
import { findCleanerBlockers } from '../services/cleaner-blockers'

export type WindowGetter = () => BrowserWindow | null

export function registerCleanerIpc(getWindow: WindowGetter): void {
  registerSystemCleanerIpc(getWindow)
  registerBrowserCleanerIpc(getWindow)
  registerAppCleanerIpc(getWindow)
  registerGamingCleanerIpc(getWindow)
  registerRecycleBinIpc()
  registerShortcutCleanerIpc(getWindow)
  registerEnvironmentCleanerIpc(getWindow)
  registerDatabaseOptimizerIpc(getWindow)
  registerRegistryCleanerIpc(getWindow)
  registerContextMenuCleanerIpc(getWindow)
  registerStartupManagerIpc()
  registerDebloaterIpc(getWindow)
  registerDiskAnalyzerIpc(getWindow)
  registerDiskTrimIpc(getWindow)
  registerDuplicateFinderIpc(getWindow)
  registerLargeFileFinderIpc(getWindow)
  registerEmptyFolderCleanerIpc(getWindow)
  registerNetworkCleanupIpc()
  registerMalwareScannerIpc(getWindow)
  registerUninstallLeftoversIpc(getWindow)
  registerPrivacyShieldIpc(getWindow)
  registerDriverManagerIpc(getWindow)
  registerPerfMonitorIpc(getWindow)
  registerProgramUninstallerIpc(getWindow)
  registerServiceManagerIpc(getWindow)
  registerFirewallAuditIpc(getWindow)
  registerSoftwareUpdaterIpc(getWindow)
  registerCloudAgentIpc()
  registerCveScannerIpc()
  registerBreachMonitorIpc()
  registerStartupSafetyIpc()
  registerProgramSafetyIpc()
  registerFileShredderIpc(getWindow)
  registerGameModeIpc(getWindow)

  // Cleaner: open file/folder location in system file manager
  ipcMain.handle(IPC.CLEANER_OPEN_LOCATION, (_event, filePath: unknown) => {
    if (typeof filePath !== 'string') return
    if (!isAbsolute(filePath)) return
    shell.showItemInFolder(filePath)
  })

  // Confirmed lock owners for the current selection. This is advisory only:
  // a failed/unsupported preflight returns no blockers and never stops a clean.
  ipcMain.handle(IPC.CLEANER_BLOCKERS, (_event, itemIds: unknown) => {
    return findCleanerBlockers(itemIds)
  })

  // Platform info
  const isWin = process.platform === 'win32'
  ipcMain.handle(IPC.PLATFORM_INFO, () => ({
    platform: process.platform as 'win32' | 'darwin' | 'linux',
    features: {
      registry: isWin,
      debloater: isWin,
      drivers: isWin,
      restorePoint: isWin,
      bootTrace: isWin,
      gameMode: isWin,
      firewallAudit: isWin,
      contextMenu: isWin,
    },
  }))

  // Settings — validate shape before persisting
  ipcMain.handle(IPC.SETTINGS_GET, () => getSettings())
  ipcMain.handle(IPC.SETTINGS_SET, async (_event, settings) => {
    const validated = validateSettingsPartial(settings)
    if (!validated) return { success: false, error: 'Invalid settings' }
    setSettings(validated)
    if (typeof validated.autoUpdate === 'boolean') {
      setAutoDownload(validated.autoUpdate)
    }
    if (typeof validated.updateCheckIntervalHours === 'number') {
      updateCheckInterval(validated.updateCheckIntervalHours)
    }
    if (typeof validated.language === 'string') {
      await flushSettings()
      app.emit('kudu:language-changed')
    }
    // Restart game detector when gameMode settings change
    if ('gameMode' in validated) {
      await flushSettings()
      refreshGameDetector(getWindow)
    }
    return { success: true }
  })

  // Settings — pick a backup folder via the OS folder picker
  ipcMain.handle(IPC.SETTINGS_SELECT_BACKUP_DIR, async () => {
    const win = getWindow()
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose Kudu backup folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: getBackupDir(),
    }
    const result = await showOpenDialog(win, opts)
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })

  // Settings — reveal the active backup folder in the OS file manager
  ipcMain.handle(IPC.SETTINGS_OPEN_BACKUP_DIR, async () => {
    const dir = getBackupDir()
    try { mkdirSync(dir, { recursive: true }) } catch { /* skip */ }
    await shell.openPath(dir)
    return dir
  })

  // Onboarding
  ipcMain.handle(IPC.ONBOARDING_GET, () => getOnboardingComplete())
  ipcMain.handle(IPC.ONBOARDING_SET, async (_event, value: boolean) => {
    if (typeof value !== 'boolean') return
    // Rejects if the write failed — the renderer logs that, so a wizard that
    // keeps reappearing leaves evidence behind (issue #269).
    await setOnboardingComplete(value)
  })

  // Elevation
  ipcMain.handle(IPC.ELEVATION_CHECK, () => isAdmin())
  ipcMain.handle(IPC.ELEVATION_RELAUNCH, () => {
    const exePath = app.getPath('exe')
    const userDataDir = app.getPath('userData')

    if (process.platform === 'win32') {
      // Use execFile so we wait for PowerShell to finish (including the UAC
      // prompt).  Start-Process -Verb RunAs blocks until the user accepts or
      // declines UAC, then returns.  If the user declines, PowerShell exits
      // with an error and we don't quit.
      const psScript = `Start-Process -FilePath '${exePath.replace(/'/g, "''")}' -Verb RunAs`
      execFile('powershell.exe', [
        '-NoProfile', '-Command', psUtf8(psScript),
      ], { windowsHide: true }, (err) => {
        if (!err) {
          app.releaseSingleInstanceLock()
          app.exit(0)
        }
      })
    } else if (process.platform === 'linux') {
      // pkexec strips the environment for security.  We forward display
      // variables (for GUI) and HOME (so Chromium resolves cache/config
      // paths to the real user dirs instead of /root).
      // AppImages run from a temporary FUSE mount, so launch the original
      // AppImage file instead of app.getPath('exe'). The current mount can be
      // removed as soon as this process exits (issue #290).
      // Use execFile so the app stays visible while the polkit dialog is
      // open — if the user cancels, we keep running. After authentication,
      // the backgrounded helper waits for this process to release the
      // single-instance lock before starting the elevated process.
      const relaunchPath = getLinuxRelaunchExecutable(exePath)
      const command = buildLinuxElevationCommand(relaunchPath, userDataDir)
      execFile('pkexec', ['/bin/sh', '-c', command], (err) => {
        if (!err) {
          app.releaseSingleInstanceLock()
          app.exit(0)
        }
        // If err, user declined or pkexec unavailable — don't quit
      })
    }
    // macOS: relaunch-as-admin is not supported — the osascript elevation
    // flow doesn't work reliably.  The renderer hides the relaunch UI on
    // darwin so this path should never be reached.
  })

  // System Restore Point
  ipcMain.handle(IPC.RESTORE_POINT_CREATE, (_event, description: string) => {
    if (typeof description !== 'string') description = ''
    // Sanitize: restrict to safe characters and cap length
    const sanitized = (description || 'Kudu pre-clean restore point')
      .replace(/[^A-Za-z0-9 ._\-()]/g, '')
      .slice(0, 200)
    return createRestorePoint(sanitized)
  })

  // Scan history — validate entry shape before persisting
  ipcMain.handle(IPC.HISTORY_GET, () => getHistory())
  ipcMain.handle(IPC.HISTORY_ADD, (_event, entry) => {
    const validated = validateHistoryEntry(entry)
    if (validated) addHistoryEntry(validated)
  })
  // Clearing scan history also drops the per-file deletion log those entries
  // point at — leaving it behind would mean "Clear" only half-cleared.
  ipcMain.handle(IPC.HISTORY_CLEAR, () => {
    clearHistory()
    clearDeletionLog()
  })

  // Deletion log — the individual paths behind a history entry
  ipcMain.handle(IPC.DELETION_LOG_QUERY, (_event, query) => {
    const validated = validateDeletionQuery(query)
    const logPath = getDeletionLogPath()
    const enabled = getSettings().cleaner.keepDeletionLog === true
    if (!validated) return { records: [], total: 0, logPath, enabled }
    const { records, total } = queryDeletions(validated)
    return { records, total, logPath, enabled }
  })

  ipcMain.handle(IPC.DELETION_LOG_EXPORT, async (_event, query) => {
    const validated = validateDeletionQuery(query)
    if (!validated) return null
    const records = queryAllDeletions({ from: validated.from, to: validated.to, origin: validated.origin })
    if (records.length === 0) return null

    const win = getWindow()
    const opts: Electron.SaveDialogOptions = {
      title: 'Export deleted files',
      defaultPath: 'kudu-deleted-files.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    }
    const result = process.platform === 'darwin' || !win
      ? await dialog.showSaveDialog(opts)
      : await dialog.showSaveDialog(win, opts)
    if (result.canceled || !result.filePath) return null

    const escape = (v: string): string => `"${v.replace(/"/g, '""')}"`
    const csv = [
      'Deleted At,Category,Size (bytes),Path',
      ...records.map((r) => [escape(r.ts), escape(r.category), String(r.size), escape(r.path)].join(',')),
    ].join('\r\n') + '\r\n'
    try {
      writeFileSync(result.filePath, csv, 'utf-8')
      return result.filePath
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.DELETION_LOG_REVEAL, async () => {
    const logPath = getDeletionLogPath()
    if (existsSync(logPath)) {
      shell.showItemInFolder(logPath)
    } else {
      // Nothing logged yet — open the folder it would be written to.
      await shell.openPath(dirname(logPath))
    }
    return logPath
  })

  ipcMain.handle(IPC.DELETION_LOG_CLEAR, () => clearDeletionLog())

  // Cloud action history
  ipcMain.handle(IPC.CLOUD_HISTORY_GET, () => getCloudHistory())
  ipcMain.handle(IPC.CLOUD_HISTORY_CLEAR, () => clearCloudHistory())

  // Auto-updater
  ipcMain.handle(IPC.UPDATER_CHECK, () => checkForUpdates())
  ipcMain.handle(IPC.UPDATER_DOWNLOAD, () => downloadUpdate())
  ipcMain.handle(IPC.UPDATER_INSTALL, () => { installUpdate() })
  ipcMain.handle(IPC.UPDATER_GET_STATUS, () => getUpdateStatus())
}
