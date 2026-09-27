import type { InstalledProgram } from './types'

export const RECENT_LAUNCH_THRESHOLD_DAYS = 90

type ProgramIdentity = Pick<InstalledProgram, 'displayName' | 'isSystemComponent'>
export type SharedComponentKind = 'filesystem' | 'runtime' | 'driver' | 'system'

/** Conservative local hints, not a complete dependency graph or a safety rating. */
export function getSharedComponentKind(program: ProgramIdentity): SharedComponentKind | null {
  if (program.isSystemComponent) return 'system'
  const name = program.displayName.trim()
  if (/^(dokan(?:y)?|winfsp)\b/i.test(name)) return 'filesystem'
  if (
    /^microsoft visual c\+\+(?:\s|$).*\b(redistributable|runtime)\b/i.test(name) ||
    /^(?:microsoft\s+)?\.net(?:\s+core)?\s+(?:framework|runtime|host|host fx resolver|sdk)\b/i.test(
      name
    ) ||
    /^microsoft (?:windows desktop runtime|asp\.net core|edge webview2 runtime)\b/i.test(name) ||
    /^(?:java(?:\(tm\))?\s+\d+|java se runtime environment|eclipse temurin|eclipse adoptium|openjdk|amazon corretto)\b/i.test(
      name
    )
  )
    return 'runtime'
  if (/\bdrivers?\b/i.test(name)) return 'driver'
  return null
}

export function canBatchUninstall(program: ProgramIdentity): boolean {
  return getSharedComponentKind(program) === null
}

/** Missing, cleared or inaccessible launch history cannot establish inactivity. */
export function hasNoRecentLaunch(
  program: Pick<InstalledProgram, 'displayName' | 'isSystemComponent' | 'lastUsed'>,
  now = Date.now()
): boolean {
  return (
    canBatchUninstall(program) &&
    Number.isFinite(program.lastUsed) &&
    program.lastUsed > 0 &&
    now - program.lastUsed > RECENT_LAUNCH_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
  )
}

export interface UninstallOptions {
  /** Set only after the user confirms the individual dependency warning. */
  dependencyWarningAcknowledged?: boolean
}
