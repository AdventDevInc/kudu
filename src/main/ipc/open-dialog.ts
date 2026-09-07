import { dialog, type BrowserWindow } from 'electron'

/**
 * Open a file/folder dialog. On Linux and macOS, omit the parent window —
 * GTK portals can crash (CachyOS Duplicate Finder) and macOS sheets freeze
 * sidebar items when parented.
 */
export function showOpenDialog(
  win: BrowserWindow | null | undefined,
  opts: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  if (process.platform === 'win32' && win) {
    return dialog.showOpenDialog(win, opts)
  }
  return dialog.showOpenDialog(opts)
}
