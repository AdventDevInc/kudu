import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { app, BrowserWindow } from 'electron'
import { IPC } from '../../shared/channels'
import type { CloudActionEntry } from '../../shared/types'

const MAX_ENTRIES = 200

let _dataDir: string | null = null
let _filePath: string | null = null

function getDataDir(): string {
  if (!_dataDir) {
    _dataDir = app.isPackaged ? app.getPath('userData') : join(app.getPath('userData'), 'Kudu-Dev')
  }
  return _dataDir
}

function getFilePath(): string {
  if (!_filePath) {
    _filePath = join(getDataDir(), 'cloud-history.json')
  }
  return _filePath
}

function ensureDir(): void {
  const dir = getDataDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function getCloudHistory(): CloudActionEntry[] {
  try {
    if (existsSync(getFilePath())) {
      const raw = readFileSync(getFilePath(), 'utf-8')
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

export function addCloudHistoryEntry(entry: CloudActionEntry): void {
  const prev = writeLock
  let unlock: () => void
  writeLock = new Promise<void>((r) => {
    unlock = r
  })
  prev.then(() => {
    try {
      ensureDir()
      const history = getCloudHistory()
      history.unshift(entry)
      if (history.length > MAX_ENTRIES) history.length = MAX_ENTRIES
      writeFileSync(getFilePath(), JSON.stringify(history, null, 2), 'utf-8')
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed()) win.webContents.send(IPC.CLOUD_HISTORY_CHANGED)
    } finally {
      unlock!()
    }
  })
}

export function clearCloudHistory(): void {
  ensureDir()
  writeFileSync(getFilePath(), '[]', 'utf-8')
}
