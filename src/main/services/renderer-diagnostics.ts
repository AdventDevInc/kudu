import { app, BrowserWindow, dialog } from 'electron'
import { release } from 'os'
import { join } from 'path'
import { t } from '../i18n'
import { logError, logInfo } from './logger'

/**
 * Attaches listeners that record renderer-side failures to the log file.
 *
 * Issue #148: a user reported a completely black window on Windows 11 with no
 * UI ever loading. The packaged app produced zero on-disk evidence — the
 * borderless frame meant there was no menu to open DevTools, and the only
 * visible error (in PowerShell) was a downstream "Render frame was disposed"
 * from the auto-updater trying to push to an already-dead renderer.
 *
 * These listeners capture the actual cause (renderer crash, preload throw,
 * resource load failure, hang) into %APPDATA%/Kudu/logs/kudu.log so future
 * reports come with diagnostic data attached. In packaged builds we also pop
 * DevTools detached on a crash so the user can grab the console output.
 */
export function attachRendererDiagnostics(
  win: BrowserWindow,
  preferences: Electron.WebPreferences
): void {
  const wc = win.webContents
  let loaded = false
  let failureReported = false

  // A hidden, frameless window cannot explain why its renderer never started.
  // Use an unparented native dialog: it also works before ready-to-show and
  // does not need a working renderer (including for the dialog itself).
  function reportStartupFailure(cause: string): void {
    if (!app.isPackaged || failureReported || win.isDestroyed() || wc.isDestroyed()) return
    failureReported = true
    const detail = [
      cause,
      `Kudu=${app.getVersion()} Electron=${process.versions.electron}`,
      `OS=${process.platform} ${release()} arch=${process.arch}`,
      `sandbox=${preferences.sandbox} contextIsolation=${preferences.contextIsolation} nodeIntegration=${preferences.nodeIntegration}`,
      `log=${join(app.getPath('userData'), 'logs', 'kudu.log')}`
    ].join('\n')
    logError(`Renderer startup failure:\n${detail}`)
    void dialog
      .showMessageBox({
        type: 'error',
        title: t('rendererStartupFailureTitle'),
        message: t('rendererStartupFailureMessage'),
        detail,
        buttons: [t('quit')],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      .catch((error: unknown) => logError('Could not show renderer startup failure dialog:', error))
      // app.quit bypasses the minimize-to-tray close interceptor in index.ts.
      .finally(() => app.quit())
  }

  wc.on('render-process-gone', (_event, details) => {
    // Windows NTSTATUS values may arrive as signed integers. Keep both forms
    // so 0xC000042C (STATUS_ELEVATION_REQUIRED, #549) is recognizable in reports.
    const cause = `Renderer process gone: reason=${details.reason} exitCode=${details.exitCode} (0x${(details.exitCode >>> 0).toString(16).toUpperCase().padStart(8, '0')})`
    logError(cause)
    if (
      details.reason === 'launch-failed' ||
      (!loaded && details.reason !== 'clean-exit' && details.reason !== 'killed')
    ) {
      reportStartupFailure(cause)
      return
    }
    if (app.isPackaged && !wc.isDestroyed() && !wc.isDevToolsOpened()) {
      try {
        wc.openDevTools({ mode: 'detach' })
      } catch {
        /* DevTools may be unavailable */
      }
    }
  })

  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // Ignore -3 (ABORTED) — fired routinely when navigation is replaced
    if (errorCode === -3) return
    logError(
      `Renderer load failed: code=${errorCode} desc=${errorDescription} url=${validatedURL} mainFrame=${isMainFrame}`
    )
    if (isMainFrame && !loaded) {
      reportStartupFailure(`Renderer load failed: code=${errorCode} desc=${errorDescription}`)
    }
  })

  wc.on('preload-error', (_event, preloadPath, error) => {
    logError(`Preload error in ${preloadPath}:`, error)
  })

  wc.on('did-finish-load', () => {
    loaded = true
    logInfo('Renderer finished loading')
  })

  win.on('unresponsive', () => {
    logError('Renderer became unresponsive')
  })

  win.on('responsive', () => {
    logInfo('Renderer responsive again')
  })

  // Forward renderer console warnings/errors to the main log. Level: 0=debug,
  // 1=info, 2=warning, 3=error. We only capture 2+ to avoid drowning the log.
  wc.on('console-message', (_event, level, message, line, sourceId) => {
    if (level < 2) return
    const label = level === 3 ? 'error' : 'warn'
    logError(`Renderer console.${label}: ${message} (${sourceId}:${line})`)
  })
}
