import { homedir } from 'os'
import { join, isAbsolute } from 'path'
import { getSettings } from './settings-store'

/** Default location for Kudu backups (registry, shell extensions, etc.) */
export function getDefaultBackupDir(): string {
  return join(homedir(), 'Documents', 'Kudu Backups')
}

/**
 * Resolve the backup directory: user-configured if set and valid, otherwise default.
 * Falls back to default for empty, non-string, or non-absolute values to keep callers safe.
 */
export function getBackupDir(): string {
  const configured = getSettings().backupPath
  if (typeof configured === 'string' && configured.length > 0 && isAbsolute(configured)) {
    return configured
  }
  return getDefaultBackupDir()
}
