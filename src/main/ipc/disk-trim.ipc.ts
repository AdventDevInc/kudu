import { ipcMain } from 'electron'
import { execFile, spawn } from 'child_process'
import { readFile } from 'fs/promises'
import { promisify } from 'util'
import { StringDecoder } from 'string_decoder'
import { IPC } from '../../shared/channels'
import { isAdmin } from '../services/elevation'
import { getLastTrimAt, setLastTrimAt, isThrottled } from '../services/trim-history-store'
import { psUtf8 } from '../services/exec-utf8'
import type { TrimDriveInfo, TrimRunResult, TrimProgress, TrimMediaType, TrimSupport, TrimStatus } from '../../shared/types'
import type { WindowGetter } from './index'

const execFileAsync = promisify(execFile)

// Module-level mutex: only one TRIM batch may run at a time.
let runningBatch = false

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000
const RECOMMEND_DISCARD_BYTES = 1024 * 1024 * 1024 // 1 GiB

// ── Status heuristic ──

function computeStatus(drive: Partial<TrimDriveInfo>, now = Date.now()): { status: TrimStatus; reason: string } {
  if (drive.trimSupport === 'macos-managed') {
    return { status: 'not-applicable', reason: 'Managed by macOS — TRIM runs automatically on Apple SSDs.' }
  }
  if (drive.mediaType === 'HDD') {
    return { status: 'not-applicable', reason: 'HDDs do not benefit from TRIM.' }
  }
  if (drive.isRemovable) {
    return { status: 'not-applicable', reason: 'Removable drive — TRIM is not recommended.' }
  }
  if (drive.trimSupport === 'unsupported') {
    return { status: 'disabled', reason: 'The filesystem or device does not support TRIM/DISCARD.' }
  }
  if (drive.trimSupport === 'disabled') {
    return { status: 'disabled', reason: 'TRIM is disabled on this drive.' }
  }
  if (drive.lastTrimAt && now - drive.lastTrimAt < SEVEN_DAYS) {
    const days = Math.max(1, Math.round((now - drive.lastTrimAt) / (24 * 60 * 60 * 1000)))
    return { status: 'recently-trimmed', reason: `Trimmed ${days} day${days === 1 ? '' : 's'} ago — no action needed.` }
  }
  if (drive.estimatedDiscardBytes && drive.estimatedDiscardBytes > RECOMMEND_DISCARD_BYTES) {
    const gb = (drive.estimatedDiscardBytes / (1024 * 1024 * 1024)).toFixed(1)
    return { status: 'recommended', reason: `${gb} GiB of unused blocks waiting to be trimmed.` }
  }
  if (drive.lastTrimAt && now - drive.lastTrimAt > THIRTY_DAYS) {
    return { status: 'recommended', reason: 'Last TRIM was over 30 days ago.' }
  }
  if (!drive.lastTrimAt) {
    return { status: 'unknown', reason: 'No TRIM history recorded — the OS may already be handling it on a schedule.' }
  }
  return { status: 'ok', reason: 'Healthy — last TRIM is recent enough.' }
}

// ── Windows ──

interface WinPhysicalDisk {
  DeviceId?: string | number
  Number?: number
  MediaType?: number | string  // PowerShell may return enum int (3=HDD, 4=SSD, 5=SCM, 0=Unspecified) or string
  BusType?: number | string
  FriendlyName?: string
}

interface WinVolume {
  Letter?: string
  Label?: string | null
  FS?: string | null
  Size?: number
  Free?: number
  DiskNumber?: number
  DriveType?: number | string  // 1=Removable, 2=Fixed, 3=Network on Get-Volume
  BitLockerStatus?: string | null
}

function mapMediaType(mediaType: WinPhysicalDisk['MediaType'], busType: WinPhysicalDisk['BusType']): TrimMediaType {
  // Get-PhysicalDisk MediaType: 3=HDD, 4=SSD, 5=SCM, 0=Unspecified
  // Some systems return strings; handle both shapes.
  const m = String(mediaType ?? '').toLowerCase()
  const b = String(busType ?? '').toLowerCase()
  if (b === 'nvme' || b === '17') return 'NVMe'
  if (m === 'ssd' || m === '4') return 'SSD'
  if (m === 'hdd' || m === '3') return 'HDD'
  return 'Unknown'
}

function mapBusType(busType: WinPhysicalDisk['BusType']): string | undefined {
  if (busType == null) return undefined
  const map: Record<string, string> = {
    '1': 'SCSI', '2': 'ATAPI', '3': 'ATA', '4': '1394', '5': 'SSA', '6': 'Fibre',
    '7': 'USB', '8': 'RAID', '9': 'iSCSI', '10': 'SAS', '11': 'SATA', '12': 'SD',
    '13': 'MMC', '15': 'FileBackedVirtual', '16': 'StorageSpaces', '17': 'NVMe',
    '18': 'MicroSSD',
  }
  const s = String(busType)
  return map[s] ?? s
}

function isLetterSafe(letter: string): boolean {
  return /^[A-Za-z]$/.test(letter)
}

async function listDrivesWindows(): Promise<TrimDriveInfo[]> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$disks = Get-PhysicalDisk | Select-Object DeviceId, Number, MediaType, BusType, FriendlyName
$volumes = @()
Get-Partition | ForEach-Object {
  $p = $_
  $v = $p | Get-Volume -ErrorAction SilentlyContinue
  if ($v -and $v.DriveLetter) {
    $bl = $null
    try { $bl = (Get-BitLockerVolume -MountPoint ("$($v.DriveLetter):") -ErrorAction Stop).ProtectionStatus.ToString() } catch {}
    $volumes += [pscustomobject]@{
      Letter = "$($v.DriveLetter)"
      Label = $v.FileSystemLabel
      FS = $v.FileSystem
      Size = [int64]$v.Size
      Free = [int64]$v.SizeRemaining
      DiskNumber = $p.DiskNumber
      DriveType = "$($v.DriveType)"
      BitLockerStatus = $bl
    }
  }
}
@{ disks = $disks; volumes = $volumes } | ConvertTo-Json -Depth 4 -Compress
`
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-Command', psUtf8(script)
  ], { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })

  let parsed: { disks?: WinPhysicalDisk[] | WinPhysicalDisk; volumes?: WinVolume[] | WinVolume } = {}
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }

  const disks = Array.isArray(parsed.disks) ? parsed.disks : parsed.disks ? [parsed.disks] : []
  const volumes = Array.isArray(parsed.volumes) ? parsed.volumes : parsed.volumes ? [parsed.volumes] : []
  const diskByNumber = new Map<number, WinPhysicalDisk>()
  for (const d of disks) {
    const num = typeof d.Number === 'number' ? d.Number : Number(d.DeviceId)
    if (!Number.isNaN(num)) diskByNumber.set(num, d)
  }

  const lastTrims = readWindowsLastTrim()
  const now = Date.now()

  const result: TrimDriveInfo[] = []
  for (const v of volumes) {
    if (!v.Letter || !isLetterSafe(v.Letter)) continue
    if (String(v.DriveType).toLowerCase() === 'network' || v.DriveType === 4) continue

    const phys = v.DiskNumber != null ? diskByNumber.get(v.DiskNumber) : undefined
    const mediaType = mapMediaType(phys?.MediaType, phys?.BusType)
    const busType = mapBusType(phys?.BusType)
    const isRemovable =
      String(v.DriveType).toLowerCase() === 'removable' ||
      v.DriveType === 2 ||
      (busType ?? '').toUpperCase() === 'USB'

    const id = v.Letter.toUpperCase()
    const lastTrimAt = lastTrims[id] ?? getLastTrimAt(id) ?? null

    const partial: Partial<TrimDriveInfo> = {
      mediaType,
      isRemovable,
      trimSupport: 'supported',
      lastTrimAt,
    }
    const { status, reason } = computeStatus(partial, now)

    result.push({
      id,
      letter: id,
      label: v.Label || `${id}:`,
      totalSize: Number(v.Size) || 0,
      freeSpace: Number(v.Free) || 0,
      mediaType,
      busType,
      filesystem: v.FS || undefined,
      isRemovable,
      isEncrypted: !!v.BitLockerStatus && v.BitLockerStatus !== 'Off',
      trimSupport: 'supported',
      status,
      statusReason: reason,
      lastTrimAt,
    })
  }
  return result
}

/**
 * Best-effort scan of the Defrag operational log for the most-recent retrim
 * event per drive letter. Returns { 'C': epochMs, ... } — empty if log is missing.
 */
function readWindowsLastTrim(): Record<string, number> {
  // Synchronous wrapper kept simple: this runs from listDrivesWindows()
  // which is async; we attempt the read in-line and swallow errors.
  return _winLastTrimCache
}

let _winLastTrimCache: Record<string, number> = {}

async function refreshWindowsLastTrim(): Promise<void> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$events = Get-WinEvent -LogName 'Microsoft-Windows-Defrag/Operational' -MaxEvents 200 -ErrorAction SilentlyContinue |
  Where-Object { $_.Id -eq 258 } |
  ForEach-Object { [pscustomobject]@{ When = $_.TimeCreated.ToUniversalTime().ToString('o'); Msg = $_.Message } }
$events | ConvertTo-Json -Depth 2 -Compress
`
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command', psUtf8(script)
    ], { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 })
    if (!stdout.trim()) { _winLastTrimCache = {}; return }
    const data: Array<{ When: string; Msg: string }> = (() => {
      try { const j = JSON.parse(stdout); return Array.isArray(j) ? j : [j] } catch { return [] }
    })()
    const out: Record<string, number> = {}
    for (const ev of data) {
      const t = Date.parse(ev.When)
      if (!Number.isFinite(t)) continue
      // Defrag event messages embed the volume identifier; pull the first letter we can find.
      const m = ev.Msg && ev.Msg.match(/(?:Volume|Drive)\s+([A-Za-z])\s*:/)
      const letter = m ? m[1].toUpperCase() : null
      if (letter && (out[letter] ?? 0) < t) out[letter] = t
    }
    _winLastTrimCache = out
  } catch {
    _winLastTrimCache = {}
  }
}

async function runTrimWindows(letter: string, getWindow: WindowGetter): Promise<TrimRunResult> {
  const start = Date.now()
  const id = letter.toUpperCase()
  if (!isLetterSafe(id)) {
    return failResult(id, start, 'Invalid drive letter')
  }
  return new Promise((resolve) => {
    const psCmd = `Optimize-Volume -DriveLetter ${id} -ReTrim -Verbose`
    const child = spawn('cmd', ['/c', `chcp 65001 >nul & powershell.exe -NoProfile -Command "${psCmd}"`], { windowsHide: true })
    let log = ''
    const out = new StringDecoder('utf-8')
    const err = new StringDecoder('utf-8')

    sendProgress(getWindow, { driveId: id, phase: 'starting', percent: -1, message: `Starting TRIM on ${id}:...` })

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = out.write(chunk)
      log += text
      const line = text.trim()
      if (line) sendProgress(getWindow, { driveId: id, phase: 'running', percent: -1, message: line.split('\n').pop() || line })
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      // Optimize-Volume writes -Verbose output to stderr in PS
      const text = err.write(chunk)
      log += text
      for (const raw of text.split('\n')) {
        const line = raw.replace(/^VERBOSE:\s*/, '').trim()
        if (line) sendProgress(getWindow, { driveId: id, phase: 'running', percent: -1, message: line })
      }
    })
    child.on('error', (e) => {
      sendProgress(getWindow, { driveId: id, phase: 'failed', percent: -1, message: e.message })
      resolve({
        driveId: id, success: false, durationMs: Date.now() - start, exitCode: null,
        summary: `Failed to start Optimize-Volume: ${e.message}`, log, timestamp: Date.now(),
      })
    })
    child.on('close', (code) => {
      const success = code === 0
      const summary = success
        ? `TRIM completed successfully on ${id}:.`
        : `Optimize-Volume exited with code ${code}.`
      sendProgress(getWindow, { driveId: id, phase: success ? 'done' : 'failed', percent: 100, message: summary })
      if (success) setLastTrimAt(id)
      resolve({
        driveId: id, success, durationMs: Date.now() - start, exitCode: code,
        summary, log, timestamp: Date.now(),
      })
    })
  })
}

// ── Linux ──

interface LsblkDevice {
  name: string
  rota?: string | number | boolean
  tran?: string | null
  type?: string
  size?: number | string
  model?: string | null
  fstype?: string | null
  children?: LsblkDevice[]
}

interface FindmntEntry {
  source: string
  target: string
  fstype?: string
  size?: number | string
  avail?: number | string
  used?: number | string
}

const FSTYPE_SKIP = new Set([
  'tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'proc', 'sysfs', 'cgroup', 'cgroup2',
  'autofs', 'mqueue', 'pstore', 'tracefs', 'debugfs', 'configfs', 'fusectl',
  'binfmt_misc', 'rpc_pipefs', 'hugetlbfs', 'efivarfs', 'bpf', 'securityfs',
])
const FSTYPE_NETWORK_PREFIXES = ['nfs', 'cifs', 'smb']
const FSTYPE_NETWORK_FUSE = new Set(['fuse.sshfs', 'fuse.s3fs', 'fuse.gvfsd-fuse'])

function isNetworkFs(fs?: string | null): boolean {
  if (!fs) return false
  const f = fs.toLowerCase()
  if (FSTYPE_NETWORK_PREFIXES.some((p) => f.startsWith(p))) return true
  if (FSTYPE_NETWORK_FUSE.has(f)) return true
  return false
}

export function deviceBaseName(devPath: string): string {
  // /dev/nvme0n1p2 -> nvme0n1; /dev/sda1 -> sda; /dev/mapper/foo -> mapper/foo (left as-is).
  // findmnt appends '[/subvol]' for btrfs subvolumes and bind mounts — strip it so
  // the lookup hits the backing block device and mediaType is detected correctly.
  const stripped = devPath.replace(/\[[^\]]*\]$/, '')
  const name = stripped.replace(/^\/dev\//, '')
  if (name.startsWith('mapper/')) return name
  // NVMe: nvme0n1p2 -> nvme0n1
  const nvme = name.match(/^(nvme\d+n\d+)p\d+$/)
  if (nvme) return nvme[1]
  // Standard: sda1 -> sda
  const std = name.match(/^([a-z]+)\d+$/)
  if (std) return std[1]
  return name
}

function findLsblkDevice(devices: LsblkDevice[], baseName: string): LsblkDevice | null {
  for (const d of devices) {
    if (d.name === baseName) return d
    if (d.children) {
      const found = findLsblkDevice(d.children, baseName)
      if (found) return found
    }
  }
  return null
}

function findEncryptedAncestor(devices: LsblkDevice[], targetName: string): boolean {
  // Walk all paths from any root; if the path to a device of name=targetName
  // includes a node with type=crypt, return true.
  function walk(node: LsblkDevice, ancestorIsCrypt: boolean): boolean {
    const isCrypt = ancestorIsCrypt || node.type === 'crypt'
    if (node.name === targetName) return isCrypt
    if (node.children) {
      for (const c of node.children) {
        if (walk(c, isCrypt)) return true
      }
    }
    return false
  }
  for (const root of devices) {
    if (walk(root, false)) return true
  }
  return false
}

/**
 * Decode the octal escapes that /proc/mounts uses for whitespace-bearing fields:
 * \040 (space), \011 (tab), \012 (newline), \134 (backslash).
 */
function decodeProcMountsField(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
}

/**
 * Best-effort fallback when `findmnt` is unavailable (busybox/Alpine, minimal containers).
 * /proc/mounts has the same data minus byte sizes, which we surface as 0.
 */
export async function readProcMounts(text?: string): Promise<FindmntEntry[]> {
  const raw = text ?? await readFile('/proc/mounts', 'utf-8').catch(() => '')
  const out: FindmntEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split(/\s+/)
    if (parts.length < 3) continue
    const source = decodeProcMountsField(parts[0])
    const target = decodeProcMountsField(parts[1])
    const fstype = decodeProcMountsField(parts[2])
    out.push({ source, target, fstype })
  }
  return out
}

async function listDrivesLinux(): Promise<TrimDriveInfo[]> {
  let lsblkData: { blockdevices?: LsblkDevice[] } = {}
  let mounts: FindmntEntry[] = []
  try {
    const { stdout } = await execFileAsync('lsblk', ['-b', '-J', '-o', 'NAME,ROTA,TRAN,TYPE,SIZE,MODEL,FSTYPE'], { timeout: 8000 })
    lsblkData = JSON.parse(stdout)
  } catch {
    return []
  }
  try {
    const { stdout } = await execFileAsync('findmnt', ['-J', '-b', '-o', 'SOURCE,TARGET,FSTYPE,SIZE,AVAIL,USED'], { timeout: 8000 })
    const findmntData: { filesystems?: FindmntEntry[] } = JSON.parse(stdout)
    mounts = findmntData.filesystems ?? []
  } catch {
    // findmnt may be missing on busybox/Alpine — fall back to /proc/mounts.
    mounts = await readProcMounts()
    if (mounts.length === 0) return []
  }

  const blockdevs = lsblkData.blockdevices ?? []
  const result: TrimDriveInfo[] = []
  const now = Date.now()

  for (const m of mounts) {
    if (!m.source.startsWith('/dev/')) continue
    if (FSTYPE_SKIP.has((m.fstype || '').toLowerCase())) continue
    if (isNetworkFs(m.fstype)) continue

    const base = deviceBaseName(m.source)
    const dev = findLsblkDevice(blockdevs, base)
    let mediaType: TrimMediaType = 'Unknown'
    let busType: string | undefined
    if (dev) {
      const rota = dev.rota
      const isRot = rota === true || rota === 1 || rota === '1'
      if ((dev.tran || '').toLowerCase() === 'nvme') mediaType = 'NVMe'
      else if (!isRot) mediaType = 'SSD'
      else mediaType = 'HDD'
      busType = dev.tran ? String(dev.tran).toUpperCase() : undefined
    }

    const isRemovable = (busType ?? '').toUpperCase() === 'USB'
    const childName = m.source.replace(/^\/dev\//, '')
    const isEncrypted = findEncryptedAncestor(blockdevs, childName)

    const id = m.target
    const lastTrimAt = getLastTrimAt(id)
    const totalSize = Number(m.size) || 0
    const freeSpace = Number(m.avail) || 0

    const partial: Partial<TrimDriveInfo> = {
      mediaType, isRemovable, trimSupport: 'supported', lastTrimAt,
    }
    const { status, reason } = computeStatus(partial, now)

    result.push({
      id,
      mountPoint: m.target,
      label: m.target === '/' ? 'Root' : m.target,
      totalSize,
      freeSpace,
      mediaType,
      busType,
      filesystem: m.fstype,
      isRemovable,
      isEncrypted,
      trimSupport: 'supported',
      status,
      statusReason: reason,
      lastTrimAt,
    })
  }
  return result
}

async function runTrimLinux(mountPoint: string, getWindow: WindowGetter): Promise<TrimRunResult> {
  const start = Date.now()
  const id = mountPoint
  if (typeof mountPoint !== 'string' || !mountPoint.startsWith('/')) {
    return failResult(id, start, 'Invalid mount point')
  }
  return new Promise((resolve) => {
    const child = spawn('fstrim', ['-v', mountPoint])
    let log = ''
    const out = new StringDecoder('utf-8')
    const err = new StringDecoder('utf-8')
    sendProgress(getWindow, { driveId: id, phase: 'starting', percent: -1, message: `Starting TRIM on ${id}...` })

    child.stdout?.on('data', (c: Buffer) => {
      const text = out.write(c); log += text
      const line = text.trim()
      if (line) sendProgress(getWindow, { driveId: id, phase: 'running', percent: -1, message: line.split('\n').pop() || line })
    })
    child.stderr?.on('data', (c: Buffer) => {
      const text = err.write(c); log += text
    })
    child.on('error', (e) => {
      resolve({ driveId: id, success: false, durationMs: Date.now() - start, exitCode: null,
        summary: `Failed to start fstrim: ${e.message}`, log, timestamp: Date.now() })
    })
    child.on('close', (code) => {
      const needsAdmin = log.toLowerCase().includes('operation not permitted')
      const success = code === 0
      let bytesDiscarded: number | undefined
      const m = log.match(/(\d+)\s+bytes\s+were\s+trimmed/i)
      if (m) bytesDiscarded = parseInt(m[1], 10)
      const summary = success
        ? bytesDiscarded != null
          ? `Trimmed ${bytesDiscarded.toLocaleString()} bytes on ${id}.`
          : `TRIM completed on ${id}.`
        : needsAdmin
          ? 'fstrim requires root privileges.'
          : `fstrim exited with code ${code}.`
      sendProgress(getWindow, { driveId: id, phase: success ? 'done' : 'failed', percent: 100, message: summary })
      if (success) setLastTrimAt(id)
      resolve({
        driveId: id, success, durationMs: Date.now() - start, exitCode: code,
        bytesDiscarded, needsAdmin: !success && needsAdmin ? true : undefined,
        summary, log, timestamp: Date.now(),
      })
    })
  })
}

// ── macOS ──

async function listDrivesMac(): Promise<TrimDriveInfo[]> {
  // Best-effort enumeration via `df -Pk` so the page isn't empty.
  // Trim is not user-actionable here; we mark all rows as macos-managed.
  try {
    const { stdout } = await execFileAsync('df', ['-Pk'], { timeout: 8000 })
    const rows: TrimDriveInfo[] = []
    const lines = stdout.trim().split('\n').slice(1)
    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 6) continue
      if (!parts[0].startsWith('/dev/')) continue
      const totalKb = parseInt(parts[1], 10) || 0
      const freeKb = parseInt(parts[3], 10) || 0
      const mount = parts.slice(5).join(' ')
      const id = mount
      rows.push({
        id,
        mountPoint: mount,
        label: mount === '/' ? 'Macintosh HD' : mount,
        totalSize: totalKb * 1024,
        freeSpace: freeKb * 1024,
        mediaType: 'SSD',
        filesystem: 'apfs',
        isRemovable: false,
        isEncrypted: false,
        trimSupport: 'macos-managed',
        status: 'not-applicable',
        statusReason: 'Managed by macOS — TRIM runs automatically on Apple SSDs.',
        lastTrimAt: null,
      })
    }
    return rows
  } catch {
    return []
  }
}

// ── Shared helpers ──

function sendProgress(getWindow: WindowGetter, data: TrimProgress): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.DISK_TRIM_PROGRESS, data)
  }
}

function failResult(driveId: string, start: number, summary: string): TrimRunResult {
  return {
    driveId, success: false, durationMs: Date.now() - start, exitCode: null,
    summary, log: '', timestamp: Date.now(),
  }
}

// ── Exported core logic ──

export async function listTrimDrives(): Promise<TrimDriveInfo[]> {
  if (process.platform === 'win32') {
    await refreshWindowsLastTrim()
    return listDrivesWindows()
  }
  if (process.platform === 'linux') {
    return listDrivesLinux()
  }
  if (process.platform === 'darwin') {
    return listDrivesMac()
  }
  return []
}

export async function runTrimForDrive(driveId: string, getWindow: WindowGetter, drives: TrimDriveInfo[]): Promise<TrimRunResult> {
  const start = Date.now()

  // macOS hard-stop: never spawn anything.
  if (process.platform === 'darwin') {
    return {
      driveId, success: false, durationMs: 0, exitCode: null,
      summary: 'TRIM is managed by macOS automatically — no action needed.',
      log: '', timestamp: Date.now(),
    }
  }

  const drive = drives.find((d) => d.id === driveId)
  if (!drive) {
    return failResult(driveId, start, `Unknown drive: ${driveId}`)
  }
  if (drive.mediaType === 'HDD') {
    return failResult(driveId, start, 'TRIM is not applicable to HDDs.')
  }
  if (drive.isRemovable) {
    return failResult(driveId, start, 'TRIM is not run on removable drives.')
  }
  if (drive.trimSupport === 'unsupported' || drive.trimSupport === 'disabled') {
    return failResult(driveId, start, drive.statusReason || 'TRIM is not supported on this drive.')
  }
  if (isThrottled(driveId)) {
    return {
      driveId, success: false, throttled: true, durationMs: 0, exitCode: null,
      summary: 'Throttled — this drive was trimmed less than 24 hours ago.',
      log: '', timestamp: Date.now(),
    }
  }
  if (!isAdmin()) {
    return {
      driveId, success: false, needsAdmin: true, durationMs: 0, exitCode: null,
      summary: 'Administrator privileges are required to run TRIM.',
      log: '', timestamp: Date.now(),
    }
  }

  if (process.platform === 'win32') {
    if (!drive.letter) return failResult(driveId, start, 'Missing drive letter')
    return runTrimWindows(drive.letter, getWindow)
  }
  if (process.platform === 'linux') {
    if (!drive.mountPoint) return failResult(driveId, start, 'Missing mount point')
    return runTrimLinux(drive.mountPoint, getWindow)
  }
  return failResult(driveId, start, `Unsupported platform: ${process.platform}`)
}

// ── IPC registration ──

export function registerDiskTrimIpc(getWindow: WindowGetter): void {
  ipcMain.handle(IPC.DISK_TRIM_LIST, () => listTrimDrives())

  ipcMain.handle(IPC.DISK_TRIM_RUN, async (_event, driveIds: unknown): Promise<TrimRunResult[]> => {
    if (!Array.isArray(driveIds)) return []
    const ids = driveIds.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 256)
    if (ids.length === 0) return []

    if (runningBatch) {
      return ids.map((id) => ({
        driveId: id, success: false, durationMs: 0, exitCode: null,
        summary: 'Another TRIM batch is already running.',
        log: '', timestamp: Date.now(),
      }))
    }
    runningBatch = true
    try {
      // Re-list drives once per batch so we have authoritative metadata
      // (mediaType, isRemovable, etc.) — never trust the renderer.
      const drives = await listTrimDrives()
      const results: TrimRunResult[] = []
      for (const id of ids) {
        results.push(await runTrimForDrive(id, getWindow, drives))
      }
      return results
    } finally {
      runningBatch = false
    }
  })
}
