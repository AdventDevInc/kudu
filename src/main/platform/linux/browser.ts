import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PlatformBrowser } from '../types'

const execFileAsync = promisify(execFile)

const browserProcesses = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'msedge',
  'brave-browser',
  'vivaldi-bin',
  'opera',
  'firefox',
  'firefox-esr',
  'thorium',
  'thorium-browser',
  'supermium',
  'helium',
  'cromite',
  'catsxp',
  'librewolf',
  'waterfox',
  'floorp',
  'zen'
]

export function createLinuxBrowser(): PlatformBrowser {
  return {
    async runningBrowsers(): Promise<string[]> {
      const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'comm='], { timeout: 5000 })
      const running = new Set(stdout.split(/\r?\n/).map((line) => line.trim().split('/').pop()))
      return browserProcesses.filter((name) => running.has(name))
    },
    async closeBrowsers(selected?: string[]): Promise<void> {
      // Use exact process name matching (-x) to avoid killing unrelated processes
      // e.g. pkill -f "opera" would match anything with "opera" in its args

      for (const proc of browserProcesses.filter((name) => !selected || selected.includes(name))) {
        try {
          await execFileAsync('/usr/bin/pkill', ['-x', proc], { timeout: 5_000 })
        } catch {
          // Process not running — ignore (pkill exits 1 when no match)
        }
      }
    }
  }
}
