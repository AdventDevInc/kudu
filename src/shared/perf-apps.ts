import type { PerfProcess } from './types'

export interface AppMemorySample {
  timestamp: number
  bytes: number
}

export interface PerfApp {
  key: string
  name: string
  path: string
  estimated: boolean
  processes: PerfProcess[]
  memBytes: number
  cpuPercent: number
  history: AppMemorySample[]
}

export const APP_HISTORY_WINDOW_MS = 15 * 60 * 1000
export const APP_HISTORY_MAX_SAMPLES = 91
export const PROCESS_STALE_MS = 30_000

export function processIdentity(process: PerfProcess): string {
  return JSON.stringify([
    process.pid,
    process.birthToken ?? process.started,
    process.name,
    process.path ?? ''
  ])
}

/** Same executable and account, not guessed parentage or a marketing app name. */
export function appKey(name: string, path: string, user: string, windows: boolean): string {
  const normalize = (value: string) => (windows ? value.toLowerCase() : value)
  return JSON.stringify([normalize(path), normalize(name), normalize(user)])
}

export function groupApps(
  processes: PerfProcess[],
  timestamp: number,
  previous: PerfApp[] = []
): PerfApp[] {
  const groups = new Map<string, PerfApp>()
  const old = new Map(previous.map((app) => [app.key, app]))
  for (const process of processes) {
    const key = process.appKey ?? appKey(process.name, process.path ?? '', process.user, false)
    let app = groups.get(key)
    if (!app) {
      app = {
        key,
        name: process.name,
        path: process.path ?? '',
        estimated: !process.path || !process.user,
        processes: [],
        memBytes: 0,
        cpuPercent: 0,
        history: []
      }
      groups.set(key, app)
    }
    app.processes.push(process)
    app.memBytes += process.memBytes
    app.cpuPercent += process.cpuPercent
  }
  for (const app of groups.values()) {
    const prior = old.get(app.key)
    const last = prior?.history.at(-1)
    const identities = new Set(prior?.processes.map(processIdentity))
    // Keep app totals across child churn, but require a verified surviving process
    // so a relaunched app / reused PID cannot inherit an unrelated trend.
    const continuous =
      last &&
      timestamp > last.timestamp &&
      timestamp - last.timestamp <= PROCESS_STALE_MS &&
      app.processes.some((p) => (p.birthToken ?? p.started) && identities.has(processIdentity(p)))
    app.history = continuous
      ? prior!.history.filter((sample) => timestamp - sample.timestamp <= APP_HISTORY_WINDOW_MS)
      : []
    app.history = [...app.history, { timestamp, bytes: app.memBytes }].slice(
      -APP_HISTORY_MAX_SAMPLES
    )
  }
  return [...groups.values()]
}

export function memoryChange(
  app: PerfApp,
  windowMs: number
): { bytes: number; seconds: number } | null {
  const last = app.history.at(-1)
  if (!last) return null
  const first = app.history.find((sample) => sample.timestamp >= last.timestamp - windowMs)
  if (!first || last.timestamp - first.timestamp < 30_000) return null
  return {
    bytes: last.bytes - first.bytes,
    seconds: Math.round((last.timestamp - first.timestamp) / 1000)
  }
}

/** A PID alone is not evidence of parentage: it may have been reused. */
export function verifiedParent(
  child: PerfProcess,
  processes: PerfProcess[]
): PerfProcess | undefined {
  if (!child.parentPid || child.parentPid === child.pid) return undefined
  const parent = processes.find((p) => p.pid === child.parentPid)
  if (!parent) return undefined
  const parentToken = parent.birthToken ?? parent.started
  const childToken = child.birthToken ?? child.started
  if (parentToken.startsWith('linux:') && childToken.startsWith('linux:')) {
    const parentTicks = parentToken.slice(6)
    const childTicks = childToken.slice(6)
    return /^\d+$/.test(parentTicks) &&
      /^\d+$/.test(childTicks) &&
      BigInt(parentTicks) < BigInt(childTicks)
      ? parent
      : undefined
  }
  const parentTime = Date.parse(parentToken.replace(/^darwin:/, ''))
  const childTime = Date.parse(childToken.replace(/^darwin:/, ''))
  return Number.isFinite(parentTime) && Number.isFinite(childTime) && parentTime < childTime
    ? parent
    : undefined
}
