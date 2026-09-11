import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** Rewrite Exec= lines that still point at the old AppImage path (#401). */
export function rewriteDesktopExec(content: string, oldPath: string, newPath: string): string {
  if (!oldPath || !newPath || oldPath === newPath) return content
  return content
    .split('\n')
    .map((line) => {
      if (!line.startsWith('Exec=') && !line.startsWith('TryExec=')) return line
      if (!line.includes(oldPath)) return line
      return line.split(oldPath).join(newPath)
    })
    .join('\n')
}

/**
 * After electron-updater renames a versioned AppImage, refresh XDG desktop
 * entries that still Exec= the deleted path. Sync on purpose: this runs inside
 * quitAndInstall before the process exits.
 */
export function retargetAppImageLaunchers(
  oldPath: string,
  newPath: string,
  applicationsDir = join(homedir(), '.local', 'share', 'applications')
): number {
  let updated = 0
  let names: string[]
  try {
    names = readdirSync(applicationsDir)
  } catch {
    return 0
  }

  for (const name of names) {
    if (!name.endsWith('.desktop')) continue
    const filePath = join(applicationsDir, name)
    let content: string
    try {
      content = readFileSync(filePath, 'utf-8')
    } catch {
      continue
    }
    const next = rewriteDesktopExec(content, oldPath, newPath)
    if (next === content) continue
    try {
      writeFileSync(filePath, next, 'utf-8')
      updated += 1
    } catch {
      /* best-effort — launcher may be root-owned */
    }
  }
  return updated
}
