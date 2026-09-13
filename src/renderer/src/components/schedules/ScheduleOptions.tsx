import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ScheduleConditions } from '@shared/schedule-policy'
import type { ScheduleEntry, ScheduleTaskType, ScanResult } from '@shared/types'
import { useScanStore } from '@/stores/scan-store'
import { ScanStatus } from '@shared/enums'

const timeText = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
const timeValue = (text: string) => {
  const [h, m] = text.split(':').map(Number)
  return h * 60 + m
}

export function ScheduleOptions({
  conditions,
  onChange,
  missedRun,
  onMissedRun
}: {
  conditions: ScheduleConditions
  onChange: (value: ScheduleConditions) => void
  missedRun: 'skip' | 'once'
  onMissedRun: (value: 'skip' | 'once') => void
}) {
  const { t } = useTranslation('schedules')
  const patch = (value: Partial<ScheduleConditions>) => onChange({ ...conditions, ...value })
  const input = 'rounded-lg border px-3 py-2 bg-transparent w-full'
  return (
    <fieldset className="mb-5 rounded-xl border p-4 space-y-4">
      <legend className="px-2 font-semibold">{t('advanced.title')}</legend>
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {t('advanced.explanation')}
      </p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={conditions.acOnly ?? false}
          onChange={(e) => patch({ acOnly: e.target.checked })}
        />
        {t('advanced.acOnly')}
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={conditions.pauseForGameMode !== false}
          onChange={(e) => patch({ pauseForGameMode: e.target.checked })}
        />
        {t('advanced.gameMode')}
      </label>
      <label className="block text-sm">
        {t('advanced.idle')}
        <input
          className={input}
          type="number"
          min={0}
          max={120}
          step={1}
          value={conditions.idleMinutes ?? 0}
          onChange={(e) => patch({ idleMinutes: Number(e.target.value) })}
        />
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={conditions.windowStart !== undefined}
          onChange={(e) =>
            patch({
              windowStart: e.target.checked ? 0 : undefined,
              windowEnd: e.target.checked ? 360 : undefined
            })
          }
        />
        {t('advanced.window')}
      </label>
      {conditions.windowStart !== undefined && (
        <div className="grid grid-cols-2 gap-3">
          <label>
            {t('advanced.from')}
            <input
              className={input}
              type="time"
              value={timeText(conditions.windowStart)}
              onChange={(e) => {
                if (e.target.value) patch({ windowStart: timeValue(e.target.value) })
              }}
            />
          </label>
          <label>
            {t('advanced.to')}
            <input
              className={input}
              type="time"
              value={timeText(conditions.windowEnd ?? 0)}
              onChange={(e) => {
                if (e.target.value) patch({ windowEnd: timeValue(e.target.value) })
              }}
            />
          </label>
        </div>
      )}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={conditions.freeBelowPercent !== undefined}
          onChange={(e) => patch({ freeBelowPercent: e.target.checked ? 15 : undefined })}
        />
        {t('advanced.disk')}
      </label>
      {conditions.freeBelowPercent !== undefined && (
        <label className="block text-sm">
          {t('advanced.freePercent')}
          <input
            className={input}
            type="number"
            min={1}
            max={100}
            step={1}
            value={conditions.freeBelowPercent}
            onChange={(e) => patch({ freeBelowPercent: Number(e.target.value) })}
          />
        </label>
      )}
      <label className="block text-sm">
        {t('advanced.missed')}
        <select
          className={input}
          value={missedRun}
          onChange={(e) => onMissedRun(e.target.value as 'skip' | 'once')}
        >
          <option value="skip">{t('advanced.skip')}</option>
          <option value="once">{t('advanced.once')}</option>
        </select>
      </label>
    </fieldset>
  )
}

export function ScheduleScope({
  task,
  label,
  selected,
  onChange
}: {
  task: ScheduleTaskType
  label: string
  selected: string[] | undefined
  onChange: (value: string[] | undefined) => void
}) {
  const { t } = useTranslation('schedules')
  const [choices, setChoices] = useState<string[]>(selected ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const scan = async () => {
    const store = useScanStore.getState()
    if (store.status === ScanStatus.Scanning || store.status === ScanStatus.Cleaning) {
      setError(t('advanced.waitForScan'))
      return
    }
    const methods: Partial<Record<ScheduleTaskType, () => Promise<ScanResult[]>>> = {
      'cleaner:system': () => window.kudu.systemScan(),
      'cleaner:browsers': () => window.kudu.browserScan(),
      'cleaner:apps': () => window.kudu.appScan(),
      'cleaner:gaming': () => window.kudu.gamingScan(),
      'cleaner:databases': () => window.kudu.databaseScan()
    }
    const method = methods[task]
    if (!method) return
    const previousStatus = store.status
    setBusy(true)
    setError('')
    store.setStatus(ScanStatus.Scanning)
    try {
      const results = await method()
      const names = [...new Set([...(selected ?? []), ...results.map((r) => r.subcategory)])].sort()
      setChoices(names)
      if (!names.length) setError(t('advanced.noCategories'))
    } catch {
      setError(t('advanced.scanFailed'))
    } finally {
      setBusy(false)
      store.setStatus(previousStatus)
      store.setProgress(null)
    }
  }
  return (
    <div className="rounded-lg border p-3 space-y-2">
      <label className="flex gap-2 items-center">
        <input
          type="checkbox"
          checked={selected !== undefined}
          onChange={(e) => onChange(e.target.checked ? [] : undefined)}
        />
        {t('advanced.restrict', { name: label })}
      </label>
      {selected !== undefined && (
        <>
          <button
            type="button"
            className="rounded border px-3 py-1 disabled:opacity-40"
            disabled={busy}
            onClick={() => void scan()}
          >
            {busy ? t('advanced.scanning') : t('advanced.findCategories')}
          </button>
          <p className="text-xs">{t('advanced.scopeHint')}</p>
          {choices.map((name) => (
            <label className="flex items-center gap-2 text-sm" key={name}>
              <input
                type="checkbox"
                checked={selected.includes(name)}
                onChange={(e) =>
                  onChange(
                    e.target.checked ? [...selected, name] : selected.filter((n) => n !== name)
                  )
                }
              />
              {name}
            </label>
          ))}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
    </div>
  )
}
