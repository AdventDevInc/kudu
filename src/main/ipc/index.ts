import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { execFile } from 'child_process'
import { isAbsolute } from 'path'
import { IPC } from '../../shared/channels'
import { psUtf8 } from '../services/exec-utf8'
import { registerSystemCleanerIpc } from './system-cleaner.ipc'
import { registerBrowserCleanerIpc } from './browser-cleaner.ipc'
import { registerAppCleanerIpc } from './app-cleaner.ipc'
import { registerGamingCleanerIpc } from './gaming-cleaner.ipc'
import { registerRecycleBinIpc } from './recycle-bin.ipc'
import { registerRegistryCleanerIpc } from './registry-cleaner.ipc'
import { registerStartupManagerIpc } from './startup-manager.ipc'
import { registerDebloaterIpc } from './debloater.ipc'
import { registerDiskAnalyzerIpc } from './disk-analyzer.ipc'
import { registerDuplicateFinderIpc } from './duplicate-finder.ipc'
import { registerNetworkCleanupIpc } from './network-cleanup.ipc'
import { registerMalwareScannerIpc } from './malware-scanner.ipc'
import { registerPrivacyShieldIpc } from './privacy-shield.ipc'
import { registerUninstallLeftoversIpc } from './uninstall-leftovers.ipc'
import { registerDriverManagerIpc } from './driver-manager.ipc'
import { registerPerfMonitorIpc } from './perf-monitor.ipc'
import { registerProgramUninstallerIpc } from './program-uninstaller.ipc'
import { registerServiceManagerIpc } from './service-manager.ipc'
import { registerSoftwareUpdaterIpc } from './software-updater.ipc'
import { registerShortcutCleanerIpc } from './shortcut-cleaner.ipc'
import { registerEnvironmentCleanerIpc } from './environment-cleaner.ipc'
import { registerDatabaseOptimizerIpc } from './database-optimizer.ipc'
import { registerCloudAgentIpc } from './cloud-agent.ipc'
import { registerLargeFileFinderIpc } from './large-file-finder.ipc'
import { registerEmptyFolderCleanerIpc } from './empty-folder-cleaner.ipc'
import { registerFileShredderIpc } from './file-shredder.ipc'
import { registerGameModeIpc } from './game-mode.ipc'
import { registerCveScannerIpc } from './cve-scanner.ipc'
import { registerBreachMonitorIpc } from './breach-monitor.ipc'
import { registerStartupSafetyIpc } from './startup-safety.ipc'
import { registerProgramSafetyIpc } from './program-safety.ipc'
import { getSettings, setSettings, flushSettings, getOnboardingComplete, setOnboardingComplete } from '../services/settings-store'
import { isAdmin } from '../services/elevation'
import { getHistory, addHistoryEntry, clearHistory } from '../services/history-store'
import { getCloudHistory, clearCloudHistory } from '../services/cloud-history-store'
import { validateSettingsPartial, validateHistoryEntry } from '../services/ipc-validation'
import { createRestorePoint } from '../services/restore-point'
import { checkForUpdates, downloadUpdate, installUpdate, getUpdateStatus, setAutoDownload, updateCheckInterval } from '../services/auto-updater'

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
  registerStartupManagerIpc()
  registerDebloaterIpc(getWindow)
  registerDiskAnalyzerIpc(getWindow)
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
    return { success: true }
  })

  // Onboarding
  ipcMain.handle(IPC.ONBOARDING_GET, () => getOnboardingComplete())
  ipcMain.handle(IPC.ONBOARDING_SET, async (_event, value: boolean) => {
    if (typeof value !== 'boolean') return
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
      // Use execFile so the app stays visible while the polkit dialog is
      // open — if the user cancels, we keep running.  The elevated process
      // is backgrounded with & so pkexec returns after auth succeeds
      // (same pattern as the macOS osascript path).
      const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
      const parts: string[] = []
      for (const key of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'HOME']) {
        if (process.env[key]) parts.push(`${key}=${sq(process.env[key])}`)
      }
      parts.push(sq(exePath), '--no-sandbox', `--kudu-data-dir=${sq(userDataDir)}`)
      execFile('pkexec', ['/bin/sh', '-c', `${parts.join(' ')} > /dev/null 2>&1 &`], (err) => {
        if (!err) {
          app.releaseSingleInstanceLock()
          app.exit(0)
        }
        // If err, user declined or pkexec unavailable — don't quit
      })
    } else if (process.platform === 'darwin') {
      // Run the binary directly as root for proper privilege elevation.
      // Background the process (&) so `do shell script` returns once the
      // binary has been started, then use execFile to wait for osascript to
      // complete (including the password prompt) before exiting.  The old
      // spawn-and-immediately-exit approach caused a race: the current app
      // would exit before the elevated process started, and macOS could
      // re-open the old registered copy via LaunchServices.
      // Pass HOME so the elevated process resolves Chromium's internal
      // cache/profile paths to the real user's directories instead of
      // /var/root (which likely lacks the expected Library sub-tree).
      // Pass --kudu-data-dir so the elevated process uses the same config.
      const homeDir = app.getPath('home')
      const escaped = exePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const escapedDataDir = userDataDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const escapedHome = homeDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const script = `do shell script "HOME=" & quoted form of "${escapedHome}" & " " & quoted form of "${escaped}" & " --no-sandbox --kudu-data-dir=" & quoted form of "${escapedDataDir}" & " > /dev/null 2>&1 &" with administrator privileges`
      execFile('osascript', ['-e', script], (err) => {
        if (!err) {
          app.releaseSingleInstanceLock()
          app.exit(0)
        }
      })
    }
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
  ipcMain.handle(IPC.HISTORY_CLEAR, () => clearHistory())

  // Cloud action history
  ipcMain.handle(IPC.CLOUD_HISTORY_GET, () => getCloudHistory())
  ipcMain.handle(IPC.CLOUD_HISTORY_CLEAR, () => clearCloudHistory())

  // Auto-updater
  ipcMain.handle(IPC.UPDATER_CHECK, () => checkForUpdates())
  ipcMain.handle(IPC.UPDATER_DOWNLOAD, () => downloadUpdate())
  ipcMain.handle(IPC.UPDATER_INSTALL, () => { installUpdate() })
  ipcMain.handle(IPC.UPDATER_GET_STATUS, () => getUpdateStatus())
}
