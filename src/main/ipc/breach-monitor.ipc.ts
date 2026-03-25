import { ipcMain } from 'electron'
import { IPC } from '../../shared/channels'
import { cloudAgent } from '../services/cloud-agent'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function registerBreachMonitorIpc(): void {
  ipcMain.handle(IPC.BREACH_MONITOR_FETCH, async () => {
    return cloudAgent.getBreachMonitor()
  })

  ipcMain.handle(IPC.BREACH_MONITOR_ADD, async (_event, emails?: unknown) => {
    if (!Array.isArray(emails) || emails.length === 0 || emails.length > 5) {
      throw new Error('Expected an array of 1-5 email addresses')
    }
    const validated: string[] = []
    for (const e of emails) {
      if (typeof e !== 'string' || !EMAIL_RE.test(e) || e.length > 254) {
        throw new Error(`Invalid email address: ${String(e).slice(0, 50)}`)
      }
      validated.push(e.toLowerCase().trim())
    }
    return cloudAgent.addBreachMonitorEmails(validated)
  })

  ipcMain.handle(IPC.BREACH_MONITOR_REMOVE, async (_event, email?: unknown) => {
    if (typeof email !== 'string' || !EMAIL_RE.test(email) || email.length > 254) {
      throw new Error('Invalid email address')
    }
    await cloudAgent.removeBreachMonitorEmail(email.toLowerCase().trim())
  })

  ipcMain.handle(IPC.BREACH_MONITOR_ACKNOWLEDGE, async (_event, breachIds?: unknown) => {
    if (!Array.isArray(breachIds) || breachIds.length === 0 || breachIds.length > 100) {
      throw new Error('Expected an array of 1-100 breach IDs')
    }
    const validated: string[] = []
    for (const id of breachIds) {
      if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
        throw new Error(`Invalid breach ID: ${String(id).slice(0, 50)}`)
      }
      validated.push(id)
    }
    return cloudAgent.acknowledgeBreaches(validated)
  })
}
