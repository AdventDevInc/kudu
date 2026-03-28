import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PlatformBrowser } from '../types'

const execFileAsync = promisify(execFile)

export function createLinuxBrowser(): PlatformBrowser {
  return {
    async closeBrowsers(): Promise<void> {
      // Use exact process name matching (-x) to avoid killing unrelated processes
      // e.g. pkill -f "opera" would match anything with "opera" in its args
      const processes = [
        'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
        'msedge', 'brave-browser', 'vivaldi-bin', 'opera', 'firefox', 'firefox-esr',
        'thorium', 'thorium-browser',
        'supermium', 'helium', 'cromite',
        'catsxp', 'librewolf', 'waterfox', 'floorp', 'zen',
      ]

      for (const proc of processes) {
        try {
          await execFileAsync('/usr/bin/pkill', ['-x', proc], { timeout: 5_000 })
        } catch {
          // Process not running — ignore (pkill exits 1 when no match)
        }
      }
    },
  }
}
