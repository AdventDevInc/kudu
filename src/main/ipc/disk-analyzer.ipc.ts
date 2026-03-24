import { BrowserWindow, ipcMain } from 'electron'
import { readdir, stat } from 'fs/promises'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { StringDecoder } from 'string_decoder'
import { join, basename, sep } from 'path'
import { IPC } from '../../shared/channels'
import { extname } from 'path'
import { isAdmin } from '../services/elevation'
import type { DiskNode, DriveInfo, FileTypeInfo, DiskRepairResult, DiskRepairProgress } from '../../shared/types'
import type { WindowGetter } from './index'
import { psUtf8 } from '../services/exec-utf8'

const execFileAsync = promisify(execFile)

const MAX_DEPTH = 3
const FILE_TYPE_MAX_DEPTH = 4

// ── Internal helpers ──

async function analyzeDirectory(
  dirPath: string,
  depth: number,
  mainWindow: BrowserWindow | null
): Promise<DiskNode> {
  const node: DiskNode = {
    name: basename(dirPath) || dirPath,
    path: dirPath,
    size: 0,
    children: []
  }

  if (depth >= MAX_DEPTH) {
    node.size = await quickSize(dirPath)
    return node
  }

  try {
    const entries = await readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      try {
        if (entry.isDirectory()) {
          const child = await analyzeDirectory(fullPath, depth + 1, mainWindow)
          node.children!.push(child)
          node.size += child.size
        } else {
          const s = await stat(fullPath)
          node.size += s.size
        }
      } catch {
        // Skip inaccessible
      }
    }

    if (depth === 0 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.SCAN_PROGRESS, {
        phase: 'scanning',
        category: 'disk',
        currentPath: dirPath,
        progress: 50,
        itemsFound: node.children!.length,
        sizeFound: node.size
      })
    }
  } catch {
    // Inaccessible directory
  }

  node.children?.sort((a, b) => b.size - a.size)
  return node
}

async function collectFileTypes(
  dirPath: string,
  depth: number,
  extMap: Map<string, { size: number; count: number }>,
  mainWindow: BrowserWindow | null
): Promise<void> {
  if (depth >= FILE_TYPE_MAX_DEPTH) return
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      try {
        if (entry.isDirectory()) {
          await collectFileTypes(fullPath, depth + 1, extMap, mainWindow)
        } else {
          const s = await stat(fullPath)
          const ext = (extname(entry.name) || '(no extension)').toLowerCase()
          const existing = extMap.get(ext)
          if (existing) {
            existing.size += s.size
            existing.count += 1
          } else {
            extMap.set(ext, { size: s.size, count: 1 })
          }
        }
      } catch {
        // Skip inaccessible
      }
    }
    if (depth === 0 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.SCAN_PROGRESS, {
        phase: 'scanning',
        category: 'disk-file-types',
        currentPath: dirPath,
        progress: 50,
        itemsFound: extMap.size,
        sizeFound: 0
      })
    }
  } catch {
    // Inaccessible directory
  }
}

async function quickSize(dirPath: string): Promise<number> {
  let size = 0
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      try {
        const s = await stat(join(dirPath, entry.name))
        size += s.isDirectory() ? 0 : s.size
      } catch {
        // Skip
      }
    }
  } catch {
    // Skip
  }
  return size
}

// ── Exported core logic ──

export async function getDrives(): Promise<DriveInfo[]> {
  if (process.platform === 'win32') {
    try {
      const driveScript = `$fixed = (Get-WmiObject Win32_LogicalDisk | Where-Object { $_.DriveType -eq 3 }).DeviceID -replace ':',''; Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null -and $fixed -contains $_.Name } | ForEach-Object { "$($_.Name)|$($_.Description)|$($_.Used)|$($_.Free)" }`
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-Command', psUtf8(driveScript)
      ], { timeout: 10000, windowsHide: true })

      const drives: DriveInfo[] = []
      for (const line of stdout.trim().split('\n')) {
        const [letter, label, used, free] = line.trim().split('|')
        if (letter && used && free) {
          const usedSpace = parseInt(used) || 0
          const freeSpace = parseInt(free) || 0
          drives.push({
            letter: letter.trim(),
            label: label?.trim() || letter.trim(),
            totalSize: usedSpace + freeSpace,
            freeSpace,
            usedSpace
          })
        }
      }
      return drives
    } catch {
      return []
    }
  }

  // macOS / Linux: parse `df` output for mounted filesystems
  try {
    const { stdout } = await execFileAsync('df', ['-Pk'], { timeout: 10000 })
    const drives: DriveInfo[] = []
    const lines = stdout.trim().split('\n').slice(1) // skip header
    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 6) continue
      const totalKb = parseInt(parts[1]) || 0
      const usedKb = parseInt(parts[2]) || 0
      const freeKb = parseInt(parts[3]) || 0
      const mount = parts.slice(5).join(' ')
      // Only include real filesystems (skip tmpfs, devfs, etc.)
      if (!parts[0].startsWith('/dev/')) continue
      drives.push({
        letter: mount,
        label: mount === '/' ? 'Root' : basename(mount),
        totalSize: totalKb * 1024,
        freeSpace: freeKb * 1024,
        usedSpace: usedKb * 1024
      })
    }
    return drives
  } catch {
    return []
  }
}

/** Resolve a drive identifier to a root path (Windows letter or Unix mount path) */
function resolveRootPath(drive: string): string | null {
  if (typeof drive !== 'string' || !drive) return null
  if (process.platform === 'win32') {
    if (/^[A-Za-z]$/.test(drive)) return `${drive.toUpperCase()}:\\`
    return null
  }
  // Unix: accept absolute paths (mount points returned by getDrives)
  if (drive.startsWith(sep)) return drive
  return null
}

export async function analyzeDisk(drive: string): Promise<DiskNode> {
  const rootPath = resolveRootPath(drive)
  if (!rootPath) return { name: '', path: '', size: 0, children: [] }
  return analyzeDirectory(rootPath, 0, null)
}

export async function getFileTypes(drive: string): Promise<FileTypeInfo[]> {
  const rootPath = resolveRootPath(drive)
  if (!rootPath) return []
  const extMap = new Map<string, { size: number; count: number }>()
  await collectFileTypes(rootPath, 0, extMap, null)
  const results: FileTypeInfo[] = []
  for (const [ext, info] of extMap) {
    results.push({ extension: ext, totalSize: info.size, fileCount: info.count })
  }
  results.sort((a, b) => b.totalSize - a.totalSize)
  return results
}

// ── Disk Repair helpers (Windows SFC / DISM) ──

function sendRepairProgress(win: BrowserWindow | null, data: DiskRepairProgress): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.DISK_REPAIR_PROGRESS, data)
  }
}

/**
 * Run SFC /scannow and stream progress to the renderer.
 * SFC outputs progress lines like "Verification 42% complete."
 */
async function runSfc(drive: string, getWindow: WindowGetter): Promise<DiskRepairResult> {
  if (process.platform !== 'win32') {
    return { tool: 'sfc', success: false, exitCode: null, summary: 'SFC is only available on Windows', log: '', requiresReboot: false, needsAdmin: false }
  }
  if (!isAdmin()) {
    return { tool: 'sfc', success: false, exitCode: null, summary: 'Administrator privileges required to run SFC', log: '', requiresReboot: false, needsAdmin: true }
  }

  // Validate drive letter — must be a single A-Z character
  const safeDrive = /^[A-Za-z]$/.test(drive) ? drive.toUpperCase() : 'C'

  return new Promise((resolve) => {
    const args = ['/scannow']
    // If a non-system drive is specified, use /offbootdir and /offwindir
    if (safeDrive !== 'C') {
      args.push(`/offbootdir=${safeDrive}:\\`, `/offwindir=${safeDrive}:\\Windows`)
    }

    const child = spawn('cmd', ['/c', 'chcp 65001 >nul & sfc', ...args], { windowsHide: true })
    let stdout = ''
    let lastPercent = 0
    const decoder = new StringDecoder('utf-8')
    const stderrDecoder = new StringDecoder('utf-8')

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = decoder.write(chunk)
      stdout += text
      // Parse progress from SFC output like "Verification 42% complete."
      const match = text.match(/(\d+)\s*%/i)
      if (match) {
        const pct = parseInt(match[1])
        if (pct > lastPercent) {
          lastPercent = pct
          sendRepairProgress(getWindow(), { tool: 'sfc', phase: 'running', percent: pct, message: `System File Checker: ${pct}% complete` })
        }
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stdout += stderrDecoder.write(chunk)
    })

    child.on('error', (err) => {
      sendRepairProgress(getWindow(), { tool: 'sfc', phase: 'failed', percent: 0, message: `SFC failed to start: ${err.message}` })
      resolve({ tool: 'sfc', success: false, exitCode: null, summary: `Failed to start SFC: ${err.message}`, log: stdout, requiresReboot: false, needsAdmin: false })
    })

    child.on('close', (code) => {
      const success = code === 0
      let summary: string
      if (stdout.includes('did not find any integrity violations')) {
        summary = 'No integrity violations found — your system files are healthy.'
      } else if (stdout.includes('successfully repaired')) {
        summary = 'Windows found and repaired corrupted system files.'
      } else if (stdout.includes('found corrupt files but was unable to fix')) {
        summary = 'Corrupted files were found but could not be repaired. Try running DISM first, then SFC again.'
      } else if (success) {
        summary = 'SFC completed successfully.'
      } else {
        summary = `SFC exited with code ${code}.`
      }

      // Check for reboot indicators — use specific phrases, not generic words
      const requiresReboot = /pending system repair|restart your computer|reboot.*required/i.test(stdout)
      sendRepairProgress(getWindow(), { tool: 'sfc', phase: success ? 'done' : 'failed', percent: 100, message: summary })
      resolve({ tool: 'sfc', success, exitCode: code, summary, log: stdout, requiresReboot, needsAdmin: false })
    })
  })
}

/**
 * Run DISM /Online /Cleanup-Image /RestoreHealth and stream progress.
 * DISM outputs progress like "[==                 10.0%                 ]"
 */
async function runDism(getWindow: WindowGetter): Promise<DiskRepairResult> {
  if (process.platform !== 'win32') {
    return { tool: 'dism', success: false, exitCode: null, summary: 'DISM is only available on Windows', log: '', requiresReboot: false, needsAdmin: false }
  }
  if (!isAdmin()) {
    return { tool: 'dism', success: false, exitCode: null, summary: 'Administrator privileges required to run DISM', log: '', requiresReboot: false, needsAdmin: true }
  }

  return new Promise((resolve) => {
    const child = spawn('cmd', ['/c', 'chcp 65001 >nul & DISM', '/Online', '/Cleanup-Image', '/RestoreHealth'], { windowsHide: true })
    let stdout = ''
    let lastPercent = 0
    const dismDecoder = new StringDecoder('utf-8')
    const dismStderrDecoder = new StringDecoder('utf-8')

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = dismDecoder.write(chunk)
      stdout += text
      const match = text.match(/(\d+(?:\.\d+)?)\s*%/i)
      if (match) {
        const pct = Math.round(parseFloat(match[1]))
        if (pct > lastPercent) {
          lastPercent = pct
          sendRepairProgress(getWindow(), { tool: 'dism', phase: 'running', percent: pct, message: `DISM RestoreHealth: ${pct}% complete` })
        }
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stdout += dismStderrDecoder.write(chunk)
    })

    child.on('error', (err) => {
      sendRepairProgress(getWindow(), { tool: 'dism', phase: 'failed', percent: 0, message: `DISM failed to start: ${err.message}` })
      resolve({ tool: 'dism', success: false, exitCode: null, summary: `Failed to start DISM: ${err.message}`, log: stdout, requiresReboot: false, needsAdmin: false })
    })

    child.on('close', (code) => {
      const success = code === 0
      let summary: string
      if (stdout.includes('The restore operation completed successfully')) {
        summary = 'DISM successfully repaired the Windows component store.'
      } else if (stdout.includes('No component store corruption detected')) {
        summary = 'No component store corruption detected — image is healthy.'
      } else if (success) {
        summary = 'DISM completed successfully.'
      } else {
        summary = `DISM exited with code ${code}. Check the log for details.`
      }

      // Check for reboot indicators — use specific phrases to avoid false positives
      const requiresReboot = /restart your computer|reboot.*required|pending reboot/i.test(stdout)
      sendRepairProgress(getWindow(), { tool: 'dism', phase: success ? 'done' : 'failed', percent: 100, message: summary })
      resolve({ tool: 'dism', success, exitCode: code, summary, log: stdout, requiresReboot, needsAdmin: false })
    })
  })
}

// ── IPC registration ──

export function registerDiskAnalyzerIpc(getWindow: WindowGetter): void {
  ipcMain.handle(IPC.DISK_DRIVES, () => getDrives())

  ipcMain.handle(IPC.DISK_FILE_TYPES, async (_event, drive: string): Promise<FileTypeInfo[]> => {
    const rootPath = resolveRootPath(drive)
    if (!rootPath) return []
    const extMap = new Map<string, { size: number; count: number }>()
    await collectFileTypes(rootPath, 0, extMap, getWindow())
    const results: FileTypeInfo[] = []
    for (const [ext, info] of extMap) {
      results.push({ extension: ext, totalSize: info.size, fileCount: info.count })
    }
    results.sort((a, b) => b.totalSize - a.totalSize)
    return results
  })

  ipcMain.handle(IPC.DISK_ANALYZE, async (_event, drive: string): Promise<DiskNode> => {
    const rootPath = resolveRootPath(drive)
    if (!rootPath) return { name: '', path: '', size: 0, children: [] }
    return analyzeDirectory(rootPath, 0, getWindow())
  })

  // Disk repair
  ipcMain.handle(IPC.DISK_REPAIR_SFC, async (_event, drive: unknown): Promise<DiskRepairResult> => {
    const safeDrive = typeof drive === 'string' && /^[A-Za-z]$/.test(drive) ? drive : 'C'
    return runSfc(safeDrive, getWindow)
  })

  ipcMain.handle(IPC.DISK_REPAIR_DISM, async (): Promise<DiskRepairResult> => {
    return runDism(getWindow)
  })
}
