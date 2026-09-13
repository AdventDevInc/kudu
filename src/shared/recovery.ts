export type RecoveryTarget =
  | { kind: 'registry-dword'; key: string; name: string }
  | { kind: 'task-enabled'; name: string }
  | { kind: 'service-start'; name: string }
export type RecoveryValue =
  number | boolean | null | { start: number; delayed: number | null; running: boolean }
export interface RecoveryEntry {
  version: 1
  id: string
  createdAt: string
  updatedAt: string
  source: 'privacy' | 'services' | 'registry'
  label: string
  target: RecoveryTarget
  before: RecoveryValue
  after: RecoveryValue
  status: 'pending' | 'ready' | 'restored' | 'failed' | 'conflict'
  error?: string
}

// Service running state is volatile (stops, reboots, partial restores) and is
// only restored on a best-effort basis, so it is excluded from the comparison.
function comparable(value: RecoveryValue): string {
  return JSON.stringify(
    value && typeof value === 'object' ? { start: value.start, delayed: value.delayed } : value
  )
}
export function recoveryDecision(
  current: RecoveryValue,
  before: RecoveryValue,
  after: RecoveryValue
) {
  const encoded = comparable(current)
  return encoded === comparable(before)
    ? 'already-restored'
    : encoded === comparable(after)
      ? 'restore'
      : 'conflict'
}

export function validateRecoveryEntry(value: unknown): value is RecoveryEntry {
  if (!value || typeof value !== 'object') return false
  const e = value as RecoveryEntry
  if (e.version !== 1 || !/^[a-f0-9-]{36}$/.test(e.id) || !e.target) return false
  if (!['privacy', 'services', 'registry'].includes(e.source)) return false
  if (!['pending', 'ready', 'restored', 'failed', 'conflict'].includes(e.status)) return false
  if (typeof e.label !== 'string' || e.label.length > 512) return false
  if (!Number.isFinite(Date.parse(e.createdAt)) || !Number.isFinite(Date.parse(e.updatedAt)))
    return false
  const t = e.target
  if (t.kind === 'registry-dword') {
    return (
      typeof t.key === 'string' &&
      /^HK(CU|LM)\\[A-Za-z0-9_ .()\\-]{1,512}$/.test(t.key) &&
      typeof t.name === 'string' &&
      /^[A-Za-z0-9_ .()-]{1,128}$/.test(t.name) &&
      [e.before, e.after].every(
        (v) => v === null || (Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 0xffffffff)
      )
    )
  }
  if (t.kind === 'task-enabled')
    return (
      typeof t.name === 'string' &&
      /^\\[A-Za-z0-9_ .()\\-]{1,512}$/.test(t.name) &&
      typeof e.before === 'boolean' &&
      typeof e.after === 'boolean'
    )
  if (t.kind === 'service-start')
    return (
      typeof t.name === 'string' &&
      /^[A-Za-z0-9_.-]{1,256}$/.test(t.name) &&
      [e.before, e.after].every(
        (v) =>
          v &&
          typeof v === 'object' &&
          [0, 1, 2, 3, 4].includes(v.start) &&
          [null, 0, 1].includes(v.delayed) &&
          typeof v.running === 'boolean'
      )
    )
  return false
}
