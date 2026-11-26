export interface WeekendAppLaunch {
  id: string
  name: string
  appPath: string
  loaded: boolean
  lastOpened: string | null
  lastError: string | null
  policy: AppLaunchPolicy
}

/** Saturday and Sunday share the Saturday's local date, including across New Year. */
export function weekendKey(now: Date): string | null {
  const day = now.getDay()
  if (day !== 0 && day !== 6) return null
  const saturday = new Date(now)
  if (day === 0) saturday.setDate(saturday.getDate() - 1)
  return [
    saturday.getFullYear(),
    String(saturday.getMonth() + 1).padStart(2, '0'),
    String(saturday.getDate()).padStart(2, '0')
  ].join('-')
}

export interface AppLaunchPolicy {
  days: number[]
  frequency: 'daily' | 'weekly'
}

export const DEFAULT_APP_POLICY: AppLaunchPolicy = { days: [6, 0], frequency: 'weekly' }

export function validateAppPolicy(input: unknown): AppLaunchPolicy {
  const policy = input as AppLaunchPolicy | undefined
  if (
    !policy ||
    !Array.isArray(policy.days) ||
    policy.days.length < 1 ||
    policy.days.length > 7 ||
    policy.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
    !['daily', 'weekly'].includes(policy.frequency)
  ) {
    throw new Error('Choose at least one valid day and a frequency.')
  }
  return { days: [...new Set(policy.days)], frequency: policy.frequency }
}

/** Self-contained because its JavaScript source is embedded in the native runner. */
export function appLaunchKey(now: Date, policy?: AppLaunchPolicy): string | null {
  const days = policy ? policy.days : [6, 0]
  if (!Number.isFinite(now.getTime()) || !days.includes(now.getDay())) return null
  const date = new Date(now)
  const weekly = !policy || policy.frequency === 'weekly'
  if (weekly) date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  return (
    (weekly ? 'week-' : 'day-') +
    [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-')
  )
}
