import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePlatform } from '@/hooks/usePlatform'
import { DEFAULT_APP_POLICY, type AppLaunchPolicy, type WeekendAppLaunch } from '@shared/app-launch'

export function WeekendAppLaunches() {
  const { platform } = usePlatform()
  const { t } = useTranslation('startup')
  const [entries, setEntries] = useState<WeekendAppLaunch[]>([])
  const [policy, setPolicy] = useState<AppLaunchPolicy>(DEFAULT_APP_POLICY)
  const [drafts, setDrafts] = useState<Record<string, AppLaunchPolicy>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    setEntries(await window.kudu.weekendAppsList())
  }, [])

  useEffect(() => {
    if (platform === 'darwin') refresh().catch((error) => setError(String(error)))
  }, [platform, refresh])

  if (platform !== 'darwin') return null

  async function change(action: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try {
      await action()
      await refresh()
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className="mb-5 rounded-2xl p-5"
      aria-labelledby="weekend-apps-title"
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}
    >
      <h2 id="weekend-apps-title" className="text-[15px] font-semibold">
        {t('weekendTitle')}
      </h2>
      <p className="mt-2 text-[13px]" style={{ color: 'var(--text-muted)' }}>
        {t('weekendDescription')}
      </p>
      <p className="mt-2 text-[13px]" style={{ color: 'var(--text-muted)' }}>
        {t('weekendLoginNotice')}
      </p>
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-red-500">
          {error}
        </p>
      )}
      <AppPolicyControls value={policy} onChange={setPolicy} disabled={busy} />
      <button
        type="button"
        disabled={busy || policy.days.length === 0}
        onClick={() => change(() => window.kudu.weekendAppsAdd(policy))}
        className="mt-4 rounded-xl px-4 py-2 text-[13px] font-medium disabled:opacity-50"
        style={{ background: 'var(--bg-subtle-2)', border: '1px solid var(--border-medium)' }}
      >
        {busy ? t('weekendWorking') : t('weekendAdd')}
      </button>
      {entries.length === 0 && (
        <p className="mt-3 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          {t('weekendEmpty')}
        </p>
      )}
      {entries.map((entry) => (
        <div
          key={entry.id}
          className="mt-4 border-t pt-3"
          style={{ borderColor: 'var(--border-default)' }}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <strong className="text-[13px]">{entry.name}</strong>
            <button
              type="button"
              disabled={busy}
              aria-label={t('weekendRemoveApp', { name: entry.name })}
              onClick={() => change(() => window.kudu.weekendAppsRemove(entry.id))}
              className="rounded-lg px-3 py-2 text-[12px] disabled:opacity-50"
              style={{ background: 'var(--bg-subtle-2)' }}
            >
              {t('weekendRemove')}
            </button>
          </div>
          <p className="mt-1 break-all text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {entry.appPath}
          </p>
          <p className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {entry.loaded ? t('weekendActive') : t('weekendNotLoaded')}
            {' · '}
            {entry.lastOpened
              ? t('weekendLastOpened', { date: new Date(entry.lastOpened).toLocaleString() })
              : t('weekendNeverOpened')}
          </p>
          <AppPolicyControls
            value={drafts[entry.id] ?? entry.policy}
            onChange={(value) => setDrafts((current) => ({ ...current, [entry.id]: value }))}
            disabled={busy}
          />
          <button
            type="button"
            className="mt-2 rounded-lg border px-3 py-2 text-[12px]"
            disabled={busy || (drafts[entry.id] ?? entry.policy).days.length === 0}
            onClick={() =>
              change(() =>
                window.kudu.weekendAppsUpdate(entry.id, drafts[entry.id] ?? entry.policy)
              )
            }
          >
            {t('scheduleSave')}
          </button>
          {entry.lastError && <p className="mt-1 text-[12px] text-red-500">{entry.lastError}</p>}
        </div>
      ))}
    </section>
  )
}

function AppPolicyControls({
  value,
  onChange,
  disabled
}: {
  value: AppLaunchPolicy
  onChange: (value: AppLaunchPolicy) => void
  disabled: boolean
}) {
  const { t } = useTranslation('startup')
  return (
    <fieldset className="mt-3" disabled={disabled}>
      <legend className="text-[13px] font-medium">{t('scheduleDays')}</legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {[1, 2, 3, 4, 5, 6, 0].map((day) => (
          <label
            key={day}
            className="flex items-center gap-1 rounded-lg border px-2 py-1 text-[12px]"
          >
            <input
              type="checkbox"
              checked={value.days.includes(day)}
              onChange={(event) =>
                onChange({
                  ...value,
                  days: event.target.checked
                    ? [...value.days, day]
                    : value.days.filter((entry) => entry !== day)
                })
              }
            />
            {t('scheduleDay' + day)}
          </label>
        ))}
      </div>
      <label className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
        {t('scheduleFrequency')}
        <select
          className="rounded-lg border px-2 py-1"
          style={{ background: 'var(--card-bg)' }}
          value={value.frequency}
          onChange={(event) =>
            onChange({ ...value, frequency: event.target.value as AppLaunchPolicy['frequency'] })
          }
        >
          <option value="weekly">{t('scheduleWeekly')}</option>
          <option value="daily">{t('scheduleDaily')}</option>
        </select>
      </label>
    </fieldset>
  )
}
