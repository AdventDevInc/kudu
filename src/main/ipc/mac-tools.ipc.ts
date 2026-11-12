import { ipcMain } from 'electron'
import { IPC } from '../../shared/channels'
import {
  animationReport,
  applyMacTool,
  batteryReport,
  energyReport,
  requireMacTools,
  spotlightReport
} from '../services/mac-tools'
import { correctMacPath, inspectMacPath, restoreMacPath } from '../services/mac-path'
import { createMacAudit, exportMacAudit } from '../services/mac-audit'

export function registerMacToolsIpc(): void {
  ipcMain.handle(IPC.MAC_TOOLS_READ, (_event, tool: unknown) => {
    requireMacTools()
    switch (tool) {
      case 'spotlight':
        return spotlightReport()
      case 'battery':
        return batteryReport()
      case 'energy':
        return energyReport()
      case 'animations':
        return animationReport()
      default:
        throw new Error('Unknown macOS diagnostic.')
    }
  })
  ipcMain.handle(IPC.MAC_TOOLS_APPLY, (_event, action: unknown) => applyMacTool(action))
  ipcMain.handle(IPC.MAC_PATH_READ, (_event, file: unknown) => inspectMacPath(file))
  ipcMain.handle(IPC.MAC_PATH_APPLY, (_event, input: unknown) => correctMacPath(input))
  ipcMain.handle(IPC.MAC_PATH_RESTORE, (_event, file: unknown) => restoreMacPath(file))
  ipcMain.handle(IPC.MAC_AUDIT_CREATE, (_event, language: unknown) => createMacAudit(language))
  ipcMain.handle(IPC.MAC_AUDIT_EXPORT, (_event, id: unknown) => exportMacAudit(id))
}
