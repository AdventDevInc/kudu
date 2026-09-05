import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'
import { lstat } from 'fs/promises'
import type { ManagedCleanupAction, ScanItem, ScanResult } from '../../shared/types'
import { execTracked } from './exec-utf8'
import { getSettings } from './settings-store'
import { isAdmin } from './elevation'

const actions = new Set<string>(['uv-prune', 'pnpm-prune', 'windows-components', 'delivery-optimization'])
const windowsAction = (action: ManagedCleanupAction) => action === 'windows-components' || action === 'delivery-optimization'
const systemExe = (name: string) => join(process.env.SystemRoot || 'C:\\Windows', 'System32', name)

// Only fixed, built-in commands are executed. Rules cannot supply a command,
// shell fragment, executable path, or arguments. Run outside any project so
// package-manager project configuration cannot change the selected operation.
async function packageCommand(action: 'uv-prune' | 'pnpm-prune', prune: boolean) {
  if (action === 'uv-prune') return execTracked('uv', ['cache', prune ? 'prune' : 'dir'], { timeout: prune ? 300_000 : 10_000, cwd: homedir() })
  const args = ['store', prune ? 'prune' : 'path']
  if (process.platform === 'win32') {
    return execTracked(systemExe('cmd.exe'), ['/d', '/s', '/c', prune ? 'pnpm store prune' : 'pnpm store path'], { timeout: prune ? 300_000 : 10_000, cwd: homedir() })
  }
  return execTracked('pnpm', args, { timeout: prune ? 300_000 : 10_000, cwd: homedir() })
}

export async function scanManagedCleanup(action: ManagedCleanupAction, category: string, label: string, fallbackPath: string): Promise<ScanResult> {
  const empty: ScanResult = { category, subcategory: label, items: [], totalSize: 0, itemCount: 0 }
  // Native tools cannot honor arbitrary Kudu exclusions; never bypass them.
  if (!actions.has(action) || (getSettings().exclusions ?? []).length) return empty
  let path = fallbackPath
  try {
    if (windowsAction(action)) {
      if (process.platform !== 'win32' || !isAdmin()) return empty
      if (action === 'delivery-optimization') {
        await execTracked(systemExe('WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Get-Command Delete-DeliveryOptimizationCache -ErrorAction Stop | Out-Null"], { timeout: 10_000 })
      } else await lstat(systemExe('dism.exe'))
    } else {
      path = (await packageCommand(action as 'uv-prune' | 'pnpm-prune', false)).stdout.trim()
      if (!isAbsolute(path) || path.includes('\n') || path.includes('\r')) return empty
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink()) return empty
    }
  } catch { return empty }
  return { ...empty, group: 'Optional maintenance', itemCount: 1, items: [{
    id: randomUUID(), path, size: 0, category, subcategory: label,
    lastModified: 0, selected: false, cleanupAction: action,
  }] }
}

const running = new Set<ManagedCleanupAction>()
export async function runManagedCleanup(item: ScanItem): Promise<{ success: boolean; reason?: string }> {
  const action = item.cleanupAction
  if (!action || !actions.has(action)) return { success: false, reason: 'unsupported-cleanup' }
  if ((getSettings().exclusions ?? []).length) return { success: false, reason: 'Native cleanup cannot honor file exclusions; use ordinary file cleanup instead.' }
  if (running.has(action)) return { success: false, reason: 'in-use' }
  if (windowsAction(action) && (process.platform !== 'win32' || !isAdmin())) return { success: false, reason: 'permission-denied' }
  running.add(action)
  try {
    if (action === 'uv-prune' || action === 'pnpm-prune') {
      const current = (await packageCommand(action, false)).stdout.trim()
      if (!isAbsolute(current) || resolve(current) !== resolve(item.path)) return { success: false, reason: 'Cache location changed; scan again.' }
      await packageCommand(action, true)
    } else if (action === 'windows-components') {
      // Deliberately omit ResetBase, which disables uninstalling installed updates.
      await execTracked(systemExe('dism.exe'), ['/Online', '/Cleanup-Image', '/StartComponentCleanup', '/NoRestart'], { timeout: 3_600_000 })
    } else {
      // Pinned files are deliberately preserved by omitting IncludePinnedFiles.
      await execTracked(systemExe('WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Delete-DeliveryOptimizationCache -Force -ErrorAction Stop"], { timeout: 300_000 })
    }
    return { success: true }
  } catch (err: any) {
    // Native tools own their accounting; never call their entire cache reclaimed.
    return { success: false, reason: err.killed ? 'Cleanup timed out.' : String(err.message || 'Native cleanup failed.').slice(0, 500) }
  } finally { running.delete(action) }
}
