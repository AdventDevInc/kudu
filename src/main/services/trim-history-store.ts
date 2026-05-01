import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const THROTTLE_WINDOW_MS = 24 * 60 * 60 * 1000

let _dataDir: string | null = null
let _path: string | null = null

function getDataDir(): string {
  if (!_dataDir) {
    _dataDir = app.isPackaged
      ? app.getPath('userData')
      : join(app.getPath('userData'), 'Kudu-Dev')
  }
  return _dataDir
}

function getPath(): string {
  if (!_path) {
    _path = join(getDataDir(), 'trim-history.json')
  }
  return _path
}

function ensureDir(): void {
  const dir = getDataDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function getTrimHistory(): Record<string, number> {
  try {
    if (existsSync(getPath())) {
      const raw = readFileSync(getPath(), 'utf-8')
      const data = JSON.parse(raw)
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const out: Record<string, number> = {}
        for (const [k, v] of Object.entries(data)) {
          if (typeof k === 'string' && typeof v === 'number' && Number.isFinite(v)) {
            out[k] = v
          }
        }
        return out
      }
    }
  } catch {
    // Corrupt file — return empty and let the next write recover
  }
  return {}
}

export function getLastTrimAt(driveId: string): number | null {
  const all = getTrimHistory()
  return all[driveId] ?? null
}

export function setLastTrimAt(driveId: string, when: number = Date.now()): void {
  const history = getTrimHistory()
  history[driveId] = when
  ensureDir()
  writeFileSync(getPath(), JSON.stringify(history, null, 2), 'utf-8')
}

/** Returns true if the drive was trimmed less than 24 hours ago. */
export function isThrottled(driveId: string, now: number = Date.now()): boolean {
  const last = getLastTrimAt(driveId)
  if (last === null) return false
  return now - last < THROTTLE_WINDOW_MS
}

/** Test-only: reset cached paths so unit tests can swap `app.getPath`. */
export function _resetTrimHistoryPathCache(): void {
  _dataDir = null
  _path = null
}
