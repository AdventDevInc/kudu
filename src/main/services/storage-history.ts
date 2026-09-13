import { app, Notification, powerMonitor } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { isAbsolute, relative, resolve, sep } from 'path'
import si from 'systeminformation'
import { getSettings } from './settings-store'
import {
  getStorageIndex,
  saveStorageScope,
  saveStorageSnapshot,
  updateStorageScope
} from './storage-history-store'
import { measureStorageScope, validateStorageRoot } from './storage-scan'
import { logError } from './logger'
import type { StorageScope, StorageSnapshot } from '../../shared/storage-history'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const mountRoot = (value: string) => (/^[A-Za-z]:$/.test(value) ? value + sep : value)
const normalized = (value: string) =>
  process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
const within = (root: string, path: string) => {
  const rel = relative(root, path)
  return !rel || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}
async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Volume information timed out')), 15000)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
export async function identifyStorageVolume(path: string) {
  const [blocks, sizes] = await withTimeout(Promise.all([si.blockDevices(), si.fsSize()]))
  const matches = sizes
    .filter((d) => d.mount && within(normalized(mountRoot(d.mount)), normalized(path)))
    .sort((a, b) => b.mount.length - a.mount.length)
  const volume = matches[0]
  if (!volume || /nfs|cifs|smb|fuse\.ssh/i.test(volume.type))
    throw new Error('Choose a local filesystem with an available volume identity')
  const block = blocks.find(
    (b) => b.mount && normalized(mountRoot(b.mount)) === normalized(mountRoot(volume.mount))
  )
  if (!block?.uuid || block.physical === 'Network')
    throw new Error('A stable local volume identity is unavailable')
  if (
    !Number.isFinite(volume.size) ||
    volume.size <= 0 ||
    !Number.isFinite(volume.available) ||
    volume.available < 0 ||
    volume.available > volume.size
  )
    throw new Error('Volume capacity measurements are unavailable')
  return {
    id: hash(block.uuid + '|' + block.fsType),
    relativeRoot: relative(resolve(mountRoot(volume.mount)), resolve(path))
      .split(sep)
      .join('/'),
    size: volume.size,
    free: volume.available
  }
}
export async function addStorageScope(path: string) {
  const root = await validateStorageRoot(path),
    volume = await identifyStorageVolume(root)
  const existing = (await getStorageIndex()).scopes.find(
    (s) => s.volumeId === volume.id && s.relativeRoot === volume.relativeRoot
  )
  if (existing) {
    if (existing.path !== root) await updateStorageScope(existing.id, { path: root, name: root })
    return { ...existing, path: root, name: root }
  }
  const scope: StorageScope = {
    id: randomUUID(),
    name: root,
    path: root,
    volumeId: volume.id,
    relativeRoot: volume.relativeRoot,
    daily: false,
    growthAlertBytes: null,
    freeAlertPercent: null,
    lastAttemptAt: null,
    lastAlertAt: null
  }
  await saveStorageScope(scope)
  return scope
}
let active: { scopeId: string; controller: AbortController; startedAt: string } | null = null
export function storageCaptureStatus() {
  return active ? { scopeId: active.scopeId, startedAt: active.startedAt } : null
}
export function cancelStorageCapture() {
  active?.controller.abort()
}
export async function captureStorageScope(id: unknown) {
  if (active) throw new Error('A storage snapshot is already running')
  const scope = (await getStorageIndex()).scopes.find((s) => s.id === id)
  if (!scope) throw new Error('Tracked folder not found')
  // Recheck after the asynchronous read so simultaneous requests cannot both start.
  if (active) throw new Error('A storage snapshot is already running')
  const controller = new AbortController(),
    started = Date.now(),
    createdAt = new Date().toISOString()
  active = { scopeId: scope.id, controller, startedAt: createdAt }
  const snapshot: StorageSnapshot = {
    version: 1,
    id: randomUUID(),
    scopeId: scope.id,
    scopeKey: '',
    createdAt,
    durationMs: 0,
    status: 'unavailable',
    reason: null,
    volumeId: scope.volumeId,
    totalBytes: 0,
    files: 0,
    skipped: 0,
    errors: 0,
    volumeSize: null,
    volumeFree: null,
    rows: []
  }
  try {
    await updateStorageScope(scope.id, { lastAttemptAt: createdAt })
    snapshot.reason = 'Capture did not complete. If no capture is running, it was interrupted.'
    await saveStorageSnapshot(snapshot)
    try {
      await validateStorageRoot(scope.path)
      const volume = await identifyStorageVolume(scope.path)
      if (volume.id !== scope.volumeId || volume.relativeRoot !== scope.relativeRoot)
        throw new Error('The selected volume or folder identity changed')
      const exclusions = [...getSettings().exclusions, app.getPath('userData')]
      snapshot.scopeKey = hash(
        JSON.stringify([
          1,
          volume.id,
          volume.relativeRoot,
          [...exclusions].sort(),
          3,
          'logical-file-bytes-no-links-no-mounts'
        ])
      )
      snapshot.volumeSize = volume.size
      snapshot.volumeFree = volume.free
      Object.assign(snapshot, await measureStorageScope(scope.path, exclusions, controller.signal))
      const finalVolume = await identifyStorageVolume(scope.path)
      if (finalVolume.id !== volume.id) {
        snapshot.status = 'partial'
        snapshot.reason = 'changed'
      } else {
        snapshot.volumeFree = finalVolume.free
        snapshot.volumeSize = finalVolume.size
      }
    } catch (error) {
      snapshot.status = controller.signal.aborted ? 'cancelled' : 'unavailable'
      snapshot.reason =
        error instanceof Error ? error.message.slice(0, 300) : 'Storage capture failed'
    }
    snapshot.durationMs = Date.now() - started
    await saveStorageSnapshot(snapshot)
    await alertForSnapshot(scope, snapshot)
    return snapshot
  } finally {
    active = null
  }
}
async function alertForSnapshot(scope: StorageScope, snapshot: StorageSnapshot) {
  if (
    snapshot.status !== 'complete' ||
    !getSettings().showNotificationOnComplete ||
    Date.now() - Date.parse(scope.lastAlertAt ?? '1970-01-01') < 86400000
  )
    return
  const previous = (await getStorageIndex()).snapshots.find(
    (s) =>
      s.id !== snapshot.id &&
      s.scopeId === scope.id &&
      s.status === 'complete' &&
      s.scopeKey === snapshot.scopeKey
  )
  const growth = previous ? snapshot.totalBytes - previous.totalBytes : 0
  const lowSpace =
    scope.freeAlertPercent !== null &&
    snapshot.volumeFree !== null &&
    snapshot.volumeSize &&
    (snapshot.volumeFree / snapshot.volumeSize) * 100 < scope.freeAlertPercent
  if ((scope.growthAlertBytes !== null && growth >= scope.growthAlertBytes) || lowSpace) {
    if (Notification.isSupported()) {
      await updateStorageScope(scope.id, { lastAlertAt: new Date().toISOString() })
      new Notification({
        title: 'Kudu Storage History',
        body: lowSpace
          ? 'A tracked volume is low on free space. Open Storage History to review.'
          : 'A tracked folder grew beyond your alert threshold. Open Storage History to review.'
      }).show()
    }
  }
}
let timer: ReturnType<typeof setInterval> | null = null,
  checking = false
async function checkDailyStorage() {
  if (checking || active) return
  checking = true
  try {
    await getStorageIndex() // Apply retention even while collection conditions defer scanning.
    if (powerMonitor.isOnBatteryPower() || powerMonitor.getSystemIdleTime() < 120) return
    if (process.platform === 'win32') {
      const { getGameModeStatus } = await import('../ipc/game-mode.ipc')
      const status = getGameModeStatus()
      if (status.active || status.pendingRestore) return
    }
    for (const scope of (await getStorageIndex()).scopes) {
      if (scope.daily && Date.now() - Date.parse(scope.lastAttemptAt ?? '1970-01-01') >= 86400000) {
        await captureStorageScope(scope.id)
        break
      }
    }
  } catch (error) {
    logError('Storage history background check failed', error)
  } finally {
    checking = false
  }
}
export function startStorageHistory() {
  if (!timer) timer = setInterval(() => void checkDailyStorage(), 600000)
}
export function stopStorageHistory() {
  if (timer) clearInterval(timer)
  timer = null
  cancelStorageCapture()
}
