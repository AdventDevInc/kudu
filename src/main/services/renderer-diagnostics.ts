import { app, BrowserWindow } from 'electron'
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
export function attachRendererDiagnostics(win: BrowserWindow): void {
  const wc = win.webContents

  wc.on('render-process-gone', (_event, details) => {
    logError(
      `Renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`
    )
    if (app.isPackaged && !wc.isDestroyed() && !wc.isDevToolsOpened()) {
      try { wc.openDevTools({ mode: 'detach' }) } catch { /* DevTools may be unavailable */ }
    }
  })

  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // Ignore -3 (ABORTED) — fired routinely when navigation is replaced
    if (errorCode === -3) return
    logError(
      `Renderer load failed: code=${errorCode} desc=${errorDescription} url=${validatedURL} mainFrame=${isMainFrame}`
    )
  })

  wc.on('preload-error', (_event, preloadPath, error) => {
    logError(`Preload error in ${preloadPath}:`, error)
  })

  wc.on('did-finish-load', () => {
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
