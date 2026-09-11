import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { app, BrowserWindow } from 'electron'
import { IPC } from '../../shared/channels'
import type { ScanHistoryEntry } from '../../shared/types'

const MAX_HISTORY = 100

let _dataDir: string | null = null
let _historyPath: string | null = null

function getDataDir(): string {
  if (!_dataDir) {
    _dataDir = app.isPackaged ? app.getPath('userData') : join(app.getPath('userData'), 'Kudu-Dev')
  }
  return _dataDir
}

function getHistoryPath(): string {
  if (!_historyPath) {
    _historyPath = join(getDataDir(), 'history.json')
  }
  return _historyPath
}

function ensureDir(): void {
  const dir = getDataDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function getHistory(): ScanHistoryEntry[] {
  try {
    if (existsSync(getHistoryPath())) {
      const raw = readFileSync(getHistoryPath(), 'utf-8')
      const data = JSON.parse(raw)
      return Array.isArray(data) ? data : []
    }
  } catch {
    // Corrupt file
  }
  return []
}

// Simple mutex to prevent concurrent read-modify-write from clobbering data
let writeLock: Promise<void> = Promise.resolve()

export function addHistoryEntry(entry: ScanHistoryEntry): void {
  const prev = writeLock
  let unlock: () => void
  writeLock = new Promise<void>((r) => {
    unlock = r
  })
  prev.then(() => {
    try {
      ensureDir()
      const history = getHistory()
      history.unshift(entry)
      if (history.length > MAX_HISTORY) history.length = MAX_HISTORY
      writeFileSync(getHistoryPath(), JSON.stringify(history, null, 2), 'utf-8')
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed()) win.webContents.send(IPC.HISTORY_CHANGED)
    } finally {
      unlock!()
    }
  })
}

export function clearHistory(): void {
  ensureDir()
  writeFileSync(getHistoryPath(), '[]', 'utf-8')
}
