import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PlatformBrowser } from '../types'

const execFileAsync = promisify(execFile)

export function createDarwinBrowser(): PlatformBrowser {
  return {
    async closeBrowsers(): Promise<void> {
      // Use killall (exact process name match) instead of pkill -f (substring match)
      // to avoid killing unrelated processes (e.g. pkill -f "Opera" matches anything with "Opera" in args)
      const browsers = [
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
        'Safari',
      ]

      for (const browser of browsers) {
        try {
          await execFileAsync('/usr/bin/killall', [browser], { timeout: 5_000 })
        } catch {
          // Process not running — ignore (killall exits 1 when no match)
        }
      }
    },
  }
}
