import { readdir, readFile, rename } from 'fs/promises'
import { existsSync } from 'fs'
import { join, basename, resolve, normalize, sep } from 'path'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import type { PlatformStartup } from '../types'
import type { StartupItem, StartupBootTrace } from '../../../shared/types'

const execFileAsync = promisify(execFile)
const HOME = homedir()

export function createLinuxStartup(): PlatformStartup {
  return {
    async listItems(): Promise<StartupItem[]> {
      const items: StartupItem[] = []

      // XDG Autostart entries
      const autostartDir = join(HOME, '.config', 'autostart')
      if (existsSync(autostartDir)) {
        try {
          const files = await readdir(autostartDir)
          for (const file of files) {
            if (!file.endsWith('.desktop') && !file.endsWith('.desktop.disabled')) continue
            try {
              const content = await readFile(join(autostartDir, file), 'utf-8')
              const name = parseDesktopField(content, 'Name') || basename(file, '.desktop')
              const exec = parseDesktopField(content, 'Exec') || ''
              const hidden = parseDesktopField(content, 'Hidden') === 'true'
              const isDisabled = file.endsWith('.disabled') || hidden

              items.push({
                id: randomUUID(),
                name: basename(file).replace('.disabled', ''),
                displayName: name,
                command: exec,
                location: join(autostartDir, file),
                source: 'autostart-desktop',
                enabled: !isDisabled,
                publisher: parseDesktopField(content, 'Comment') || '',
                impact: 'low',
              })
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }

      // Systemd user services
      try {
        const { stdout } = await execFileAsync('/usr/bin/systemctl', [
          '--user', 'list-unit-files', '--type=service', '--no-pager', '--plain',
        ], { timeout: 10_000 })

        for (const line of stdout.split('\n').slice(1)) {
          const parts = line.trim().split(/\s+/)
          if (parts.length < 2) continue
          const [unit, state] = parts
          if (!unit.endsWith('.service')) continue

          items.push({
            id: randomUUID(),
            name: unit,
            displayName: unit.replace('.service', ''),
            command: '',
            location: unit,
            source: 'systemd-user',
            enabled: state === 'enabled',
            publisher: '',
            impact: 'low',
          })
        }
      } catch { /* systemd not available */ }

      // @reboot cron entries
      try {
        const { stdout } = await execFileAsync('/usr/bin/crontab', ['-l'], { timeout: 5_000 })
        for (const line of stdout.split('\n')) {
          if (line.startsWith('@reboot')) {
            const command = line.replace('@reboot', '').trim()
            items.push({
              id: randomUUID(),
              name: command.split(/\s+/)[0] || command,
              displayName: command.split('/').pop() || command,
              command,
              location: 'crontab',
              source: 'cron',
              enabled: true,
              publisher: '',
              impact: 'low',
            })
          }
        }
      } catch { /* no crontab */ }

      return items
    },

    async toggleItem(
      name: string,
      location: string,
      _command: string,
      source: StartupItem['source'],
      enabled: boolean,
    ): Promise<boolean> {
      try {
        if (source === 'autostart-desktop') {
          // Validate location is within the autostart directory to prevent arbitrary file renames
          const autostartDir = resolve(join(HOME, '.config', 'autostart'))
          const resolved = resolve(normalize(location))
          if (!resolved.startsWith(autostartDir + sep)) {
            return false
          }
          if (enabled && location.endsWith('.disabled')) {
            await rename(location, location.replace('.disabled', ''))
          } else if (!enabled && !location.endsWith('.disabled')) {
            await rename(location, location + '.disabled')
          }
          return true
        }

        if (source === 'systemd-user') {
          const action = enabled ? 'enable' : 'disable'
          await execFileAsync('/usr/bin/systemctl', ['--user', action, name], { timeout: 10_000 })
          return true
        }

        return false
      } catch {
        return false
      }
    },

    async getBootTrace(): Promise<StartupBootTrace> {
      return {
        available: false,
        needsAdmin: false,
        totalBootMs: 0,
        mainPathMs: 0,
        startupAppsMs: 0,
        lastBootDate: null,
        entries: [],
      }
    },
  }
}

function parseDesktopField(content: string, field: string): string | null {
  const match = content.match(new RegExp(`^${field}=(.+)$`, 'm'))
  return match ? match[1].trim() : null
}
