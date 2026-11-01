import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PlatformBrowser } from '../types'

const execFileAsync = promisify(execFile)

const browserProcesses = [
  'Google Chrome',
  'Microsoft Edge',
  'Brave Browser',
  'Vivaldi',
  'Opera',
  'firefox',
  'Arc',
  'Chromium',
  'Thorium',
  'Supermium',
  'Helium',
  'Cromite',
  'CatsXP',
  'LibreWolf',
  'Waterfox',
  'Floorp',
  'Zen Browser',
  'Safari'
]

export function createDarwinBrowser(): PlatformBrowser {
  return {
    async runningBrowsers(): Promise<string[]> {
      const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'comm='], { timeout: 5000 })
      const running = new Set(stdout.split(/\r?\n/).map((line) => line.trim().split('/').pop()))
      return browserProcesses.filter((name) => running.has(name))
    },
    async closeBrowsers(selected?: string[]): Promise<void> {
      // Use killall (exact process name match) instead of pkill -f (substring match)
      // to avoid killing unrelated processes (e.g. pkill -f "Opera" matches anything with "Opera" in args)

      for (const browser of browserProcesses.filter(
        (name) => !selected || selected.includes(name)
      )) {
        try {
          await execFileAsync('/usr/bin/killall', [browser], { timeout: 5_000 })
        } catch {
          // Process not running — ignore (killall exits 1 when no match)
        }
      }
    }
  }
}
