import { BrowserWindow, clipboard, Menu, MenuItem } from 'electron'

/** Offer native copying for selected text and the visible text of links. */
export function attachCopyContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    if (params.selectionText) {
      Menu.buildFromTemplate([{ role: 'copy' }]).popup({ window })
    } else if (params.linkText) {
      // Reuse Electron's localized label, but copy the displayed value instead
      // of its search URL. A role would override this custom click handler.
      const label = new MenuItem({ role: 'copy' }).label
      Menu.buildFromTemplate([{ label, click: () => clipboard.writeText(params.linkText) }]).popup({
        window
      })
    }
  })
}
