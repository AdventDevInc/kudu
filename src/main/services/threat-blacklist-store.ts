import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { ThreatBlacklist } from './cloud-agent-types'

const MAX_ENTRIES_PER_ARRAY = 500_000
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024 // 50 MB
const DOWNLOAD_TIMEOUT_MS = 60_000

let _dataDir: string | null = null

function getDataDir(): string {
  if (!_dataDir) {
    _dataDir = app.isPackaged ? app.getPath('userData') : join(app.getPath('userData'), 'Kudu-Dev')
  }
  return _dataDir
}

function getBlacklistPath(): string {
  return join(getDataDir(), 'threat-blacklist.json')
}

export function validateBlacklist(raw: unknown): ThreatBlacklist | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null

  const obj = raw as Record<string, unknown>
  if (typeof obj.version !== 'string' || obj.version.length === 0 || obj.version.length > 100)
    return null
  if (typeof obj.updatedAt !== 'string' || obj.updatedAt.length === 0 || obj.updatedAt.length > 100)
    return null

  if (!Array.isArray(obj.domains) || obj.domains.length > MAX_ENTRIES_PER_ARRAY) return null
  if (!Array.isArray(obj.ips) || obj.ips.length > MAX_ENTRIES_PER_ARRAY) return null
  if (!Array.isArray(obj.cidrs) || obj.cidrs.length > MAX_ENTRIES_PER_ARRAY) return null

  // Validate all entries are strings with reasonable length
  for (const arr of [obj.domains, obj.ips, obj.cidrs]) {
    for (const item of arr as unknown[]) {
      if (typeof item !== 'string' || item.length === 0 || item.length > 500) return null
    }
  }

  return {
    version: obj.version,
    updatedAt: obj.updatedAt,
    domains: obj.domains as string[],
    ips: obj.ips as string[],
    cidrs: obj.cidrs as string[]
  }
}

export function loadBlacklist(): ThreatBlacklist | null {
  try {
    const path = getBlacklistPath()
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf-8')
    return validateBlacklist(JSON.parse(raw))
  } catch {
    return null
  }
}

export function saveBlacklist(bl: ThreatBlacklist): void {
  const dir = getDataDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const path = getBlacklistPath()
  const tmpPath = path + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(bl), 'utf-8')
  renameSync(tmpPath, path)
}

export async function downloadAndUpdateBlacklist(url: string): Promise<{
  success: boolean
  error?: string
  stats?: { domains: number; ips: number; cidrs: number }
}> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)

    let response: Response
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      return { success: false, error: `Download failed: HTTP ${response.status}` }
    }

    // Check content-length if available
    const contentLength = response.headers.get('content-length')
    if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_BYTES) {
      return { success: false, error: 'Blacklist too large (exceeds 50 MB)' }
    }

    const text = await response.text()
    if (text.length > MAX_DOWNLOAD_BYTES) {
      return { success: false, error: 'Blacklist too large (exceeds 50 MB)' }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { success: false, error: 'Invalid blacklist format: JSON parse error' }
    }

    const blacklist = validateBlacklist(parsed)
    if (!blacklist) {
      return { success: false, error: 'Invalid blacklist format: validation failed' }
    }

    saveBlacklist(blacklist)

    return {
      success: true,
      stats: {
        domains: blacklist.domains.length,
        ips: blacklist.ips.length,
        cidrs: blacklist.cidrs.length
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: `Download failed: ${msg}`.slice(0, 200) }
  }
}
