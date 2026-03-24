import { readdir, readFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { join, basename, resolve, normalize, sep } from 'path'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import type { PlatformStartup } from '../types'
import type { StartupItem, StartupBootTrace } from '../../../shared/types'

const execFileAsync = promisify(execFile)
const HOME = resolve(homedir())

export function createDarwinStartup(): PlatformStartup {
  return {
    async listItems(): Promise<StartupItem[]> {
      const items: StartupItem[] = []

      // User Launch Agents
      const userAgentsDir = join(HOME, 'Library', 'LaunchAgents')
      if (existsSync(userAgentsDir)) {
        try {
          const files = await readdir(userAgentsDir)
          for (const file of files) {
            if (!file.endsWith('.plist')) continue
            try {
              const plist = await parsePlistLabel(join(userAgentsDir, file))
              const label = plist.label || basename(file, '.plist')
              const isDisabled = plist.disabled === true

              items.push({
                id: randomUUID(),
                name: label,
                displayName: friendlyName(label),
                command: plist.program || plist.programArguments?.[0] || file,
                location: join(userAgentsDir, file),
                source: 'launch-agent-user',
                enabled: !isDisabled,
                publisher: extractPublisher(label),
                impact: 'low',
              })
            } catch { /* skip unparseable plists */ }
          }
        } catch { /* skip */ }
      }

      // Global Launch Agents
      const globalAgentsDir = resolve('/Library/LaunchAgents')
      if (existsSync(globalAgentsDir)) {
        try {
          const files = await readdir(globalAgentsDir)
          for (const file of files) {
            if (!file.endsWith('.plist')) continue
            try {
              const plist = await parsePlistLabel(join(globalAgentsDir, file))
              const label = plist.label || basename(file, '.plist')
              const isDisabled = plist.disabled === true

              items.push({
                id: randomUUID(),
                name: label,
                displayName: friendlyName(label),
                command: plist.program || plist.programArguments?.[0] || file,
                location: join(globalAgentsDir, file),
                source: 'launch-agent-global',
                enabled: !isDisabled,
                publisher: extractPublisher(label),
                impact: 'low',
              })
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }

      // Login Items via osascript
      try {
        const { stdout } = await execFileAsync('/usr/bin/osascript', [
          '-e', 'tell application "System Events" to get the name of every login item',
        ], { timeout: 10_000 })

        const loginItems = stdout.trim().split(', ').filter(Boolean)
        for (const name of loginItems) {
          items.push({
            id: randomUUID(),
            name,
            displayName: name,
            command: '',
            location: 'Login Items',
            source: 'login-item',
            enabled: true,
            publisher: '',
            impact: 'medium',
          })
        }
      } catch { /* skip */ }

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
        if (source === 'launch-agent-user' || source === 'launch-agent-global') {
          // Validate location is within a known LaunchAgents directory
          const allowedDirs = [
            join(HOME, 'Library', 'LaunchAgents'),
            resolve('/Library/LaunchAgents'),
          ]
          const resolved = resolve(normalize(location))
          if (!allowedDirs.some(dir => resolved.startsWith(dir + sep))) {
            return false
          }
          if (enabled) {
            await execFileAsync('/bin/launchctl', ['load', location], { timeout: 10_000 })
          } else {
            await execFileAsync('/bin/launchctl', ['unload', location], { timeout: 10_000 })
          }
          return true
        }
        if (source === 'login-item') {
          // Sanitize name to prevent AppleScript injection
          const safeName = name.replace(/[\\"]/g, '')
          if (enabled) {
            await execFileAsync('/usr/bin/osascript', [
              '-e', `tell application "System Events" to make login item at end with properties {name:"${safeName}", hidden:false}`,
            ], { timeout: 10_000 })
          } else {
            await execFileAsync('/usr/bin/osascript', [
              '-e', `tell application "System Events" to delete login item "${safeName}"`,
            ], { timeout: 10_000 })
          }
          return true
        }
        return false
      } catch {
        return false
      }
    },

    async deleteItem(
      name: string,
      location: string,
      source: StartupItem['source'],
    ): Promise<boolean> {
      try {
        if (source === 'launch-agent-user' || source === 'launch-agent-global') {
          const allowedDirs = [
            join(HOME, 'Library', 'LaunchAgents'),
            resolve('/Library/LaunchAgents'),
          ]
          const resolved = resolve(normalize(location))
          if (!allowedDirs.some(dir => resolved.startsWith(dir + sep))) {
            return false
          }
          // Unload first, then delete the plist file
          try {
            await execFileAsync('/bin/launchctl', ['unload', location], { timeout: 10_000 })
          } catch { /* may already be unloaded */ }
          await unlink(location)
          return true
        }
        if (source === 'login-item') {
          const safeName = name.replace(/[\\"]/g, '')
          await execFileAsync('/usr/bin/osascript', [
            '-e', `tell application "System Events" to delete login item "${safeName}"`,
          ], { timeout: 10_000 })
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

/** Extract a human-friendly name from a reverse-DNS label like com.apple.foo */
function friendlyName(label: string): string {
  const parts = label.split('.')
  return parts.length > 2 ? parts.slice(2).join('.') : label
}

/** Extract publisher from reverse-DNS label */
function extractPublisher(label: string): string {
  const parts = label.split('.')
  if (parts.length >= 2) return parts[1]
  return ''
}

/** Parse a plist file for Label, Disabled, Program, ProgramArguments using plutil */
async function parsePlistLabel(path: string): Promise<{
  label?: string
  disabled?: boolean
  program?: string
  programArguments?: string[]
}> {
  const { stdout } = await execFileAsync('/usr/bin/plutil', [
    '-convert', 'json', '-o', '-', path,
  ], { timeout: 5_000 })

  const data = JSON.parse(stdout)
  return {
    label: data.Label,
    disabled: data.Disabled === true,
    program: data.Program,
    programArguments: data.ProgramArguments,
  }
}
