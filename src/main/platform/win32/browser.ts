import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PlatformBrowser } from '../types'

const execFileAsync = promisify(execFile)

export function createWin32Browser(): PlatformBrowser {
  return {
    async closeBrowsers(): Promise<void> {
      const browserProcesses = [
        'chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe',
        'opera.exe', 'firefox.exe', 'arc.exe', 'chromium.exe',
        'thorium.exe', 'supermium.exe', 'helium.exe', 'cromite.exe',
        'CatsXP.exe', 'librewolf.exe', 'waterfox.exe', 'floorp.exe', 'zen.exe',
      ]
      for (const proc of browserProcesses) {
        try {
          await execFileAsync('taskkill', ['/IM', proc, '/F'], { timeout: 5000 })
        } catch {
          // Process not running, ignore
        }
      }
    },
  }
}
