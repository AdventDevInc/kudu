import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron'
import { execFile } from 'child_process'
import { readFileSync } from 'fs'
import { promisify } from 'util'
import { join } from 'path'

const execFileAsync = promisify(execFile)
import { execNativeUtf8 } from './services/exec-utf8'
import { IPC } from '../shared/channels'
import { t } from './i18n'
import { registerCleanerIpc } from './ipc'
import { getSettings } from './services/settings-store'
import { startScheduler, stopScheduler, getNextScanTime, notifyScheduledScanComplete, completeScheduleRun } from './services/scheduler'
import { initAutoUpdater } from './services/auto-updater'
import { cloudAgent } from './services/cloud-agent'
import { runCli } from './cli'
import { runDaemon } from './daemon'

// ─── Disable hardware acceleration ──────────────────────────
// Must be called before app.whenReady().  On machines with incompatible
// GPU drivers, broken ANGLE, or certain VM setups, Chromium's GPU
// compositor silently fails — resulting in a black window that the user
// can resize but never see content in.  For a system-cleaner utility the
// visual trade-off (software compositing) is negligible.
app.disableHardwareAcceleration()

// ─── Headless mode flags ─────────────────────────────────────
// When running without a GUI (daemon or CLI), disable sandbox
// so Electron works on headless Linux servers without X11/Wayland.
// IMPORTANT: Clear DISPLAY before Chromium initializes — otherwise the
// native layer picks the X11 ozone backend before app.commandLine
// switches are processed, and crashes if no X server is running.
if (process.argv.includes('--daemon') || process.argv.includes('--cli')) {
  delete process.env.DISPLAY
  delete process.env.WAYLAND_DISPLAY
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('ozone-platform', 'headless')
}

// ─── Data directory override ────────────────────────────────
// When relaunched as root (macOS/Linux), the elevated process receives
// --kudu-data-dir=<path> so it reads/writes the original user's config
// instead of /var/root/... or /root/...
const dataDirFlag = process.argv.find(a => a.startsWith('--kudu-data-dir='))
if (dataDirFlag) {
  const dir = dataDirFlag.slice('--kudu-data-dir='.length)
  if (dir && require('path').isAbsolute(dir)) {
    app.setPath('userData', dir)
  }
}

// ─── Root detection (macOS + Linux) ─────────────────────────
// Chromium refuses to run as root without --no-sandbox.  Also required
// on macOS for clipboard access (paste) in the elevated process.
if (
  (process.platform === 'linux' || process.platform === 'darwin') &&
  typeof process.getuid === 'function' &&
  process.getuid() === 0
) {
  app.commandLine.appendSwitch('no-sandbox')
}

// ─── CLI / Daemon mode ───────────────────────────────────────
// If --cli is passed, run headless and exit — no GUI, no tray.
// If --daemon is passed, run headless cloud agent and stay alive.
if (process.argv.includes('--cli')) {
  app.whenReady().then(() => runCli())
} else if (process.argv.includes('--daemon')) {
  app.whenReady().then(() => runDaemon())
} else {
  initGui()
}

function initGui(): void {

// Prevent multiple instances — if another is already running, focus it and quit this one
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  return
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let ipcRegistered = false

function getIconPath(): string {
  const ext = process.platform === 'darwin' ? 'icns' : process.platform === 'linux' ? 'png' : 'ico'
  return app.isPackaged
    ? join(process.resourcesPath, `icon.${ext}`)
    : join(__dirname, `../../resources/icon.${ext}`)
}

function getIconsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icons')
    : join(__dirname, '../../resources/icons')
}

function createTrayIcon(): Electron.NativeImage {
  if (process.platform === 'darwin') {
    // Build a multi-resolution image so the icon is sharp on Retina displays.
    // Uses pre-rendered 16×16 (@1x) and 32×32 (@2x) PNGs instead of
    // down-scaling the 1024×1024 app icon at runtime.
    const dir = getIconsDir()
    const trayIcon = nativeImage.createEmpty()
    trayIcon.addRepresentation({ scaleFactor: 1.0, width: 16, height: 16, buffer: readFileSync(join(dir, '16x16.png')) })
    trayIcon.addRepresentation({ scaleFactor: 2.0, width: 32, height: 32, buffer: readFileSync(join(dir, '32x32.png')) })
    trayIcon.setTemplateImage(true)
    return trayIcon
  }

  // Windows / Linux: load the main icon and resize to standard tray size
  const ext = process.platform === 'win32' ? 'ico' : 'png'
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, `icon.${ext}`)
    : join(__dirname, `../../resources/icon.${ext}`)
  return nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
}

const TASK_NAME = 'KuduStartup'

async function applyAutoLaunchWin32(enabled: boolean): Promise<void> {
  // Use Task Scheduler with RunLevel HighestAvailable so the app starts
  // elevated at logon. The HKCU Run key is NOT a viable fallback because
  // the exe manifest is requireAdministrator — Windows silently skips
  // Run-key entries for executables with an admin manifest.
  const exePath = app.getPath('exe')

  if (enabled) {
    // Remove any stale task first, then create a fresh one
    try {
      await execNativeUtf8('schtasks',[
        '/Delete', '/TN', TASK_NAME, '/F'
      ], { timeout: 10000 })
    } catch { /* task may not exist yet */ }

    // Build the task via XML so the /TR value is never subject to
    // schtasks command-line quoting quirks (common cause of silent failures
    // when the exe path contains spaces, e.g. "C:\Program Files\...").
    const xml = [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      '  <Triggers>',
      '    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>',
      '    <SessionStateChangeTrigger>',
      '      <Enabled>true</Enabled>',
      '      <StateChange>ConsoleConnect</StateChange>',
      '    </SessionStateChangeTrigger>',
      '  </Triggers>',
      '  <Principals>',
      '    <Principal id="Author">',
      '      <LogonType>InteractiveToken</LogonType>',
      '      <RunLevel>HighestAvailable</RunLevel>',
      '    </Principal>',
      '  </Principals>',
      '  <Settings>',
      '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
      '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
      '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
      '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
      '    <Enabled>true</Enabled>',
      '  </Settings>',
      '  <Actions Context="Author">',
      `    <Exec>`,
      `      <Command>${escapeXml(exePath)}</Command>`,
      '      <Arguments>--startup</Arguments>',
      '    </Exec>',
      '  </Actions>',
      '</Task>'
    ].join('\r\n')

    const tmpPath = join(app.getPath('temp'), `${TASK_NAME}.xml`)
    const { writeFile, unlink } = await import('fs/promises')
    await writeFile(tmpPath, '\uFEFF' + xml, 'utf-16le')

    try {
      await execNativeUtf8('schtasks',[
        '/Create',
        '/TN', TASK_NAME,
        '/XML', tmpPath,
        '/F',
      ], { timeout: 10000 })
    } finally {
      unlink(tmpPath).catch(() => {})
    }

    // Verify the task was actually registered
    await execNativeUtf8('schtasks',[
      '/Query', '/TN', TASK_NAME
    ], { timeout: 10000 })
  } else {
    try {
      await execNativeUtf8('schtasks',[
        '/Delete', '/TN', TASK_NAME, '/F'
      ], { timeout: 10000 })
    } catch { /* task may not exist */ }
  }

  // Clear any leftover Electron Run-key entry so it doesn't conflict
  app.setLoginItemSettings({ openAtLogin: false })
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function applyAutoLaunch(enabled: boolean): Promise<void> {
  // Only register auto-launch when packaged — in dev mode this would register
  // the bare Electron binary, causing a generic "Getting Started" window on reboot.
  if (!app.isPackaged) return

  if (process.platform === 'win32') {
    await applyAutoLaunchWin32(enabled)
  } else {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: ['--startup']
    })
  }
}

function createTray(): void {
  if (tray) return

  tray = new Tray(createTrayIcon())
  tray.setToolTip(t('trayTooltip'))

  const contextMenu = Menu.buildFromTemplate([
    {
      label: t('openKudu'),
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show()
          mainWindow.focus()
        } else {
          createWindow()
        }
      }
    },
    { type: 'separator' },
    {
      label: t('quit'),
      click: () => {
        // Force quit — don't intercept close
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.removeAllListeners('close')
        }
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    } else {
      createWindow()
    }
  })
}

/** Rebuild the tray context menu (e.g. after a language change) */
function rebuildTrayMenu(): void {
  if (!tray) return
  tray.setToolTip(t('trayTooltip'))
  const contextMenu = Menu.buildFromTemplate([
    {
      label: t('openKudu'),
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show()
          mainWindow.focus()
        } else {
          createWindow()
        }
      }
    },
    { type: 'separator' },
    {
      label: t('quit'),
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.removeAllListeners('close')
        }
        app.quit()
      }
    }
  ])
  tray.setContextMenu(contextMenu)
}

function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

function createWindow(): void {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize
  const width = Math.round(screenWidth * 0.75)
  const height = Math.round(screenHeight * 0.8)

  const icon = nativeImage.createFromPath(getIconPath())

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#09090b',
    icon,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  const settings = getSettings()
  // Detect startup launch: --startup flag (Windows Task Scheduler / Linux),
  // or macOS wasOpenedAtLogin (since macOS 13+ drops argv from login items).
  const isStartupLaunch = process.argv.includes('--startup')
    || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin)

  mainWindow.on('ready-to-show', () => {
    // If launched at startup with minimize-to-tray, stay hidden
    if (isStartupLaunch && settings.minimizeToTray) {
      // Don't show — just sit in tray
    } else {
      mainWindow?.show()
    }
  })

  // Intercept close to minimize to tray if enabled
  mainWindow.on('close', (e) => {
    const currentSettings = getSettings()
    if (currentSettings.minimizeToTray && mainWindow && !mainWindow.isDestroyed()) {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Only allow opening HTTPS URLs externally
    try {
      const url = new URL(details.url)
      if (url.protocol === 'https:') {
        shell.openExternal(details.url)
      }
    } catch {
      // Invalid URL, ignore
    }
    return { action: 'deny' }
  })

  // Register IPC handlers only once to avoid stacking on window recreation
  if (!ipcRegistered) {
    // Window control IPC — use current mainWindow reference
    ipcMain.on(IPC.WINDOW_MINIMIZE, () => mainWindow?.minimize())
    ipcMain.on(IPC.WINDOW_MAXIMIZE, () => {
      if (mainWindow?.isMaximized()) {
        mainWindow.unmaximize()
      } else {
        mainWindow?.maximize()
      }
    })
    ipcMain.on(IPC.WINDOW_CLOSE, () => mainWindow?.close())

    // Register all IPC handlers (pass getter so handlers always use current window)
    registerCleanerIpc(() => mainWindow)

    ipcRegistered = true
  }

  // Load the app
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  }
})

app.whenReady().then(() => {
  // On macOS, ensure the Dock icon is visible.  When relaunched as root
  // via osascript the binary is executed directly (not through `open` /
  // LaunchServices), so the Dock icon won't appear automatically.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show()
  }

  // Ensure an Edit menu exists so clipboard shortcuts (Cmd+C/V/X on macOS,
  // Ctrl+C/V/X elsewhere) work in the frameless window.  On macOS Cmd+V
  // relies on an Edit menu with the paste role — without an explicit menu
  // the shortcuts break when the app is relaunched as root.
  // We preserve the default appMenu role so Cmd+Q, Cmd+H, About, etc. stay.
  const appMenu = Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    }
  ])
  Menu.setApplicationMenu(appMenu)

  const settings = getSettings()

  // Apply auto-launch setting
  applyAutoLaunch(settings.runAtStartup).catch((err) => {
    console.error('Failed to configure auto-launch:', err)
  })

  // Create tray if minimize-to-tray is enabled or any schedule is active
  if (settings.minimizeToTray || settings.schedules.some((s) => s.enabled)) {
    createTray()
  }

  createWindow()

  // Initialize auto-updater
  initAutoUpdater()

  // Start the scheduled scan checker
  startScheduler(() => mainWindow)

  // Start cloud agent if linked
  if (settings.cloud.apiKey) {
    cloudAgent.start()
  }

  // Listen for settings changes to update auto-launch and tray
  ipcMain.handle(IPC.SETTINGS_APPLY_STARTUP, async (_event, enabled: boolean) => {
    await applyAutoLaunch(enabled)
  })

  ipcMain.on(IPC.SETTINGS_APPLY_TRAY, (_event, enabled: boolean) => {
    if (enabled) {
      createTray()
    } else if (!getSettings().schedules.some((s) => s.enabled)) {
      destroyTray()
    }
  })

  // Rebuild tray menu when language changes so labels update immediately
  app.on('kudu:language-changed' as any, () => {
    rebuildTrayMenu()
  })

  // IPC to get next scan time for the UI
  ipcMain.handle(IPC.SCHEDULE_NEXT_SCAN, () => {
    const s = getSettings()
    const next = getNextScanTime(s)
    return next ? next.toISOString() : null
  })

  // Handle scheduled scan completion notification from renderer
  ipcMain.on(IPC.SCHEDULE_SCAN_COMPLETE, (_event, totalSize: number, itemCount: number) => {
    notifyScheduledScanComplete(totalSize, itemCount)
  })

  // Handle multi-schedule run completion
  const VALID_RUN_STATUSES = new Set(['success', 'partial', 'failed', 'never'])
  ipcMain.on(IPC.SCHEDULE_RUN_COMPLETE, (_event, scheduleId: unknown, status: unknown) => {
    if (typeof scheduleId !== 'string' || typeof status !== 'string') return
    if (!VALID_RUN_STATUSES.has(status)) return
    completeScheduleRun(scheduleId, status as 'success' | 'partial' | 'failed' | 'never')
  })

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Window exists but may be hidden (minimize-to-tray) — restore it
      mainWindow.show()
      mainWindow.focus()
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  const settings = getSettings()
  // Don't quit if minimize-to-tray or any schedule is enabled
  if (settings.minimizeToTray || settings.schedules.some((s) => s.enabled)) {
    // Stay alive in tray
    return
  }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopScheduler()
  cloudAgent.stop()
})

} // end initGui
