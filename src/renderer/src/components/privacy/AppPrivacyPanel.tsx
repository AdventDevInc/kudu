import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Camera, Mic, MapPin, RefreshCw, ExternalLink, Search, Info } from 'lucide-react'
import {
  APP_PRIVACY_CAPABILITIES,
  appPrivacyLastUse,
  type AppPrivacyCapability,
  type AppPrivacyReport
} from '@shared/app-privacy'

const icons = { webcam: Camera, microphone: Mic, location: MapPin }
const card = { background: 'var(--card-bg)', border: '1px solid var(--border-default)' }

export function AppPrivacyPanel() {
  const { t, i18n } = useTranslation('hardening')
  const [report, setReport] = useState<AppPrivacyReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [settingsError, setSettingsError] = useState(false)
  const [capability, setCapability] = useState<AppPrivacyCapability | 'all'>('all')
  const [query, setQuery] = useState('')
  const [recent, setRecent] = useState(false)
  const [limit, setLimit] = useState(50)
  const mounted = useRef(false)
  const refreshing = useRef(false)

  async function refresh() {
    if (refreshing.current) return
    refreshing.current = true
    setLoading(true)
    setError(false)
    try {
      const result = await window.kudu.appPrivacyScan()
      if (mounted.current) setReport(result)
    } catch {
      if (mounted.current) setError(true)
    } finally {
      refreshing.current = false
      if (mounted.current) setLoading(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
    }
  }, [])

  const cutoff = Date.parse(report?.scannedAt ?? '') - 30 * 86400000
  const records = report?.records ?? []
  const filtered = records.filter(
    (row) =>
      (capability === 'all' || row.capability === capability) &&
      (!recent || Date.parse(appPrivacyLastUse(row) ?? '') >= cutoff) &&
      `${row.name} ${row.identity}`.toLowerCase().includes(query.trim().toLowerCase())
  )
  const formatDate = (value: string) => new Date(value).toLocaleString(i18n.language)
  const partial = report?.capabilities.some(
    (c) => c.status === 'partial' || c.status === 'unavailable' || c.truncated
  )

  return (
    <section aria-label={t('appPrivacy.title')} aria-busy={loading}>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('appPrivacy.title')}
          </h2>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('appPrivacy.description')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
          style={card}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          {t('appPrivacy.refresh')}
        </button>
      </div>
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm"
          style={{ color: 'var(--warning)' }}
        >
          {t(report ? 'appPrivacy.refreshFailed' : 'appPrivacy.failed')}
        </p>
      )}
      {loading && !report && (
        <p
          role="status"
          className="py-12 text-center text-sm"
          style={{ color: 'var(--text-secondary)' }}
        >
          {t('appPrivacy.loading')}
        </p>
      )}
      {report && !report.supported && (
        <p className="rounded-xl p-6 text-sm" style={card}>
          {t('appPrivacy.unsupported')}
        </p>
      )}
      {report?.supported && (
        <>
          <p className="mb-4 text-xs break-words" style={{ color: 'var(--text-muted)' }}>
            {t('appPrivacy.account', {
              account: report.account || t('appPrivacy.unknownAccount'),
              time: formatDate(report.scannedAt)
            })}
          </p>
          {partial && (
            <p
              role="status"
              className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
              style={{ color: 'var(--warning)' }}
            >
              {t('appPrivacy.partial')}
            </p>
          )}
          <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-3">
            {APP_PRIVACY_CAPABILITIES.map((cap) => {
              const summary = report.capabilities.find((item) => item.capability === cap)
              const entries = records.filter((row) => row.capability === cap)
              const recentCount = entries.filter(
                (row) => Date.parse(appPrivacyLastUse(row) ?? '') >= cutoff
              ).length
              const Icon = icons[cap]
              return (
                <div key={cap} className="rounded-2xl p-4" style={card}>
                  <div className="mb-3 flex items-center gap-2">
                    <Icon
                      className="h-5 w-5"
                      style={{ color: 'var(--brand-solid)' }}
                      aria-hidden="true"
                    />
                    <h3 className="text-sm font-semibold">{t(`appPrivacy.capability.${cap}`)}</h3>
                  </div>
                  <div className="mb-1 text-2xl font-bold">
                    {entries.length.toLocaleString(i18n.language)}{' '}
                    <span
                      className="text-xs font-normal"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {t('appPrivacy.entries')}
                    </span>
                  </div>
                  <p className="mb-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {t('appPrivacy.recentCount', { count: recentCount })}
                  </p>
                  <dl className="space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {(['deviceConsent', 'userConsent', 'desktopConsent'] as const).map((key) => (
                      <div key={key} className="flex justify-between gap-2">
                        <dt>{t(`appPrivacy.${key}`)}</dt>
                        <dd>{t(`appPrivacy.consent.${summary?.[key] ?? 'unknown'}`)}</dd>
                      </div>
                    ))}
                  </dl>
                  {summary?.status !== 'available' && (
                    <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {t(`appPrivacy.status.${summary?.status ?? 'unavailable'}`)}
                    </p>
                  )}
                  {summary?.truncated && (
                    <p className="mt-2 text-xs" style={{ color: 'var(--warning)' }}>
                      {t('appPrivacy.truncated')}
                    </p>
                  )}
                  <button
                    type="button"
                    className="mt-4 flex items-center gap-1.5 text-xs font-semibold"
                    style={{ color: 'var(--brand-solid)' }}
                    onClick={async () => {
                      setSettingsError(false)
                      try {
                        await window.kudu.appPrivacyOpenSettings(cap)
                      } catch {
                        setSettingsError(true)
                      }
                    }}
                  >
                    {t('appPrivacy.settings', { capability: t(`appPrivacy.capability.${cap}`) })}
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
              )
            })}
          </div>
          {settingsError && (
            <p role="alert" className="mb-4 text-sm" style={{ color: 'var(--warning)' }}>
              {t('appPrivacy.settingsFailed')}
            </p>
          )}
          <details className="mb-5 rounded-xl p-4 text-xs leading-relaxed" style={card}>
            <summary className="cursor-pointer font-medium">
              <Info className="mr-2 inline h-4 w-4" aria-hidden="true" />
              {t('appPrivacy.limitationsTitle')}
            </summary>
            <p className="mt-3" style={{ color: 'var(--text-secondary)' }}>
              {t('appPrivacy.limitations')}
            </p>
            <p className="mt-2" style={{ color: 'var(--text-secondary)' }}>
              {t('appPrivacy.accountHelp')}
            </p>
          </details>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <label className="relative min-w-48 flex-1">
              <span className="sr-only">{t('appPrivacy.search')}</span>
              <Search
                className="pointer-events-none absolute left-3 top-3 h-4 w-4"
                style={{ color: 'var(--text-muted)' }}
                aria-hidden="true"
              />
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setLimit(50)
                }}
                placeholder={t('appPrivacy.search')}
                className="w-full rounded-xl py-2.5 pl-9 pr-3 text-sm"
                style={card}
              />
            </label>
            <label>
              <span className="sr-only">{t('appPrivacy.filter')}</span>
              <select
                value={capability}
                onChange={(event) => {
                  setCapability(event.target.value as typeof capability)
                  setLimit(50)
                }}
                className="rounded-xl p-2.5 text-sm"
                style={card}
              >
                <option value="all">{t('appPrivacy.all')}</option>
                {APP_PRIVACY_CAPABILITIES.map((cap) => (
                  <option key={cap} value={cap}>
                    {t(`appPrivacy.capability.${cap}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={recent}
                onChange={(event) => {
                  setRecent(event.target.checked)
                  setLimit(50)
                }}
              />
              {t('appPrivacy.recent')}
            </label>
          </div>
          <p role="status" className="mb-3 text-xs" style={{ color: 'var(--text-muted)' }}>
            {t('appPrivacy.showing', {
              shown: Math.min(limit, filtered.length),
              total: filtered.length
            })}
          </p>
          {filtered.length === 0 ? (
            <div className="rounded-2xl p-10 text-center text-sm" style={card}>
              {t(records.length ? 'appPrivacy.noMatches' : 'appPrivacy.noRecords')}
            </div>
          ) : (
            <ul className="overflow-hidden rounded-2xl" style={card}>
              {filtered.slice(0, limit).map((row) => {
                const Icon = icons[row.capability]
                return (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-start gap-3 border-b p-4 last:border-b-0"
                    style={{ borderColor: 'var(--border-default)' }}
                  >
                    <Icon
                      className="mt-1 h-4 w-4 shrink-0"
                      style={{ color: 'var(--brand-solid)' }}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="break-words text-sm font-semibold">{row.name}</p>
                      <p className="mt-1 break-all text-xs" style={{ color: 'var(--text-muted)' }}>
                        {row.identity}
                      </p>
                      <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {t(`appPrivacy.kind.${row.kind}`)} ·{' '}
                        {t(`appPrivacy.capability.${row.capability}`)} ·{' '}
                        {t('appPrivacy.recordedConsent', {
                          consent: t(`appPrivacy.consent.${row.consent}`)
                        })}
                      </p>
                    </div>
                    <div className="max-w-full text-xs" style={{ color: 'var(--text-secondary)' }}>
                      <p>
                        {row.lastAccess
                          ? t('appPrivacy.lastAccess', { time: formatDate(row.lastAccess) })
                          : t('appPrivacy.noTime')}
                      </p>
                      {row.lastEnd && (
                        <p className="mt-1">
                          {t('appPrivacy.lastEnd', { time: formatDate(row.lastEnd) })}
                        </p>
                      )}
                      {row.usage === 'unfinished' && (
                        <p className="mt-1" style={{ color: 'var(--warning)' }}>
                          {t('appPrivacy.unfinished')}
                        </p>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {filtered.length > limit && (
            <button
              type="button"
              className="mt-3 w-full rounded-xl p-3 text-sm font-medium"
              style={card}
              onClick={() => setLimit((value) => value + 50)}
            >
              {t('appPrivacy.more')}
            </button>
          )}
          <p className="mt-4 text-xs" style={{ color: 'var(--text-muted)' }}>
            {t('appPrivacy.local')}
          </p>
        </>
      )}
    </section>
  )
}
