import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PlatformBrowser } from '../types'

const execFileAsync = promisify(execFile)

const browserProcesses = [
  'chrome.exe',
  'msedge.exe',
  'brave.exe',
  'vivaldi.exe',
  'opera.exe',
  'firefox.exe',
  'arc.exe',
  'chromium.exe',
  'thorium.exe',
  'supermium.exe',
  'helium.exe',
  'cromite.exe',
  'CatsXP.exe',
  'librewolf.exe',
  'waterfox.exe',
  'floorp.exe',
  'zen.exe'
]

export function createWin32Browser(): PlatformBrowser {
  return {
    async runningBrowsers(): Promise<string[]> {
      const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 5000 })
      const running = new Set(
        stdout.split(/\r?\n/).map((line) => line.split('"')[1]?.toLowerCase())
      )
      return browserProcesses.filter((name) => running.has(name.toLowerCase()))
    },
    async closeBrowsers(selected?: string[]): Promise<void> {
      for (const proc of browserProcesses.filter((name) => !selected || selected.includes(name))) {
        try {
          await execFileAsync('taskkill', ['/IM', proc, '/F'], { timeout: 5000 })
        } catch {
          // Process not running, ignore
        }
      }
    }
  }
}
