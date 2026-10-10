import { getAppSpaceCleanerView } from '@shared/app-space-handoff'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  HardDrive,
  Package,
  Search,
  Sparkles,
  Loader2,
  RefreshCw,
  Info
} from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { ErrorAlert } from '@/components/shared/ErrorAlert'
import { formatBytes } from '@/lib/utils'
import { useScanStore } from '@/stores/scan-store'
import { useUninstallerStore } from '@/stores/uninstaller-store'
import { ScanStatus } from '@shared/enums'
import type { AppSpaceEntry, AppSpaceReport } from '@shared/types'
import './app-space.css'

export function AppSpacePage() {
  const { t } = useTranslation('appSpace')
  const navigate = useNavigate()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [report, setReport] = useState<AppSpaceReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('cache')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const entries = useMemo(
    () =>
      (report?.entries ?? [])
        .filter((entry) =>
          `${entry.name} ${entry.publisher}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
        )
        .sort((a, b) =>
          sort === 'name'
            ? a.name.localeCompare(b.name)
            : sort === 'installed'
              ? (b.installedBytes ?? -1) - (a.installedBytes ?? -1)
              : b.cacheBytes - a.cacheBytes
        ),
    [report, query, sort]
  )
  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0]
  const cacheTotal = report?.entries.reduce((total, entry) => total + entry.cacheBytes, 0) ?? 0
  const largest = Math.max(1, ...entries.map((entry) => entry.cacheBytes))
  async function scan() {
    setBusy(true)
    setError('')
    try {
      const next = await window.kudu.appSpaceScan()
      if (mounted.current) setReport(next)
    } catch {
      if (mounted.current) setError(t('scanError'))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  async function review(entry: AppSpaceEntry) {
    const store = useScanStore.getState()
    if (store.status === ScanStatus.Scanning || store.status === ScanStatus.Cleaning) {
      setError(t('cleanerBusy'))
      return
    }
    const previousStatus = store.status
    const previousResults = store.results
    store.setStatus(ScanStatus.Scanning)
    setReviewing(true)
    setError('')
    let reviewToken: string | null = null
    try {
      const review = await window.kudu.appSpaceReview(
        entry.rules.map((rule) => rule.id),
        store.appSpaceHandoffToken
      )
      reviewToken = review.token
      const results = review.results
      const current = useScanStore.getState()
      if (
        !mounted.current ||
        current.status !== ScanStatus.Scanning ||
        current.results !== previousResults
      )
        return
      if (!results.length) {
        setError(t('nothingLeft'))
        return
      }
      store.reset()
      store.setResults(results)
      store.setAppSpaceHandoffToken(reviewToken)
      store.setStatus(ScanStatus.Complete)
      navigate('/cleaner', { state: getAppSpaceCleanerView(results) })
    } catch {
      if (mounted.current) setError(t('reviewError'))
    } finally {
      const current = useScanStore.getState()
      if (current.status === ScanStatus.Scanning && current.results === previousResults)
        current.setStatus(previousStatus)
      // The scalar token keeps acknowledgements independent of the number of files.
      if (reviewToken)
        await window.kudu
          .appSpaceRetain(reviewToken, useScanStore.getState().appSpaceHandoffToken)
          .catch((error) => console.error('Could not acknowledge app-space review', error))
      if (mounted.current) setReviewing(false)
    }
  }
  return (
    <div className="app-space-page">
      <PageHeader
        title={t('pageTitle')}
        description={t('description')}
        action={
          <button className="app-space-primary" disabled={busy || reviewing} onClick={scan}>
            {busy ? (
              <Loader2 size={16} className="animate-spin" />
            ) : report ? (
              <RefreshCw size={16} />
            ) : (
              <Search size={16} />
            )}{' '}
            {t(busy ? 'scanning' : report ? 'refresh' : 'scan')}
          </button>
        }
      />
      {error && <ErrorAlert message={error} onDismiss={() => setError('')} />}
      {!report ? (
        <section className="app-space-intro">
          <span className="app-space-hero-icon">
            <Package size={34} />
          </span>
          <h2>{t('introTitle')}</h2>
          <p>{t('introDescription')}</p>
          <div className="app-space-intro-points">
            <span>
              <HardDrive size={18} />
              {t('installed')}
            </span>
            <span>
              <Sparkles size={18} />
              {t('cache')}
            </span>
          </div>
          <p className="app-space-muted">{t('privacy')}</p>
        </section>
      ) : (
        <>
          <div className="app-space-stats">
            <section>
              <span>{t('appsListed')}</span>
              <strong>{report.entries.length}</strong>
              <small>{t('inventoryNote')}</small>
            </section>
            <section>
              <span>{t('cacheFound')}</span>
              <strong className="app-space-green">{formatBytes(cacheTotal)}</strong>
              <small>{t('cacheNote')}</small>
            </section>
            <section>
              <span>{t('lastScan')}</span>
              <strong className="app-space-time">
                {new Date(report.scannedAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </strong>
              <small>{t('localOnly')}</small>
            </section>
          </div>
          <p className="app-space-scope">
            <Info size={16} />
            <span>
              {t('scope')}
              {!report.inventoryAvailable ? ` ${t('inventoryUnavailable')}` : ''}
              {report.unavailableRules
                ? ` ${t('partial', { count: report.unavailableRules })}`
                : ''}
            </span>
          </p>
          <div className="app-space-workspace">
            <section className="app-space-list" aria-label={t('appsListed')}>
              <div className="app-space-tools">
                <label className="app-space-search">
                  <Search size={17} />
                  <input
                    aria-label={t('search')}
                    placeholder={t('search')}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <select
                  aria-label={t('sort')}
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                >
                  <option value="cache">{t('sortCache')}</option>
                  <option value="installed">{t('sortInstalled')}</option>
                  <option value="name">{t('sortName')}</option>
                </select>
              </div>
              <div className="app-space-columns">
                <span>{t('application')}</span>
                <span>{t('installed')}</span>
                <span>{t('cache')}</span>
              </div>
              <div className="app-space-rows">
                {entries.map((entry) => (
                  <button
                    className="app-space-row"
                    data-selected={selected?.id === entry.id}
                    aria-pressed={selected?.id === entry.id}
                    key={entry.id}
                    onClick={() => setSelectedId(entry.id)}
                  >
                    <span className="app-space-name">
                      <span className="app-space-app-icon">
                        <Package size={18} />
                      </span>
                      <span>
                        <strong>{entry.name}</strong>
                        <small>
                          {entry.publisher ||
                            t(entry.programId ? 'installedApp' : 'knownCacheOwner')}
                        </small>
                        <span className="app-space-meter" aria-hidden="true">
                          <i style={{ width: `${(entry.cacheBytes / largest) * 100}%` }} />
                        </span>
                      </span>
                    </span>
                    <span className="app-space-size">
                      {entry.installedBytes === null
                        ? t('unknown')
                        : formatBytes(entry.installedBytes)}
                      <small>
                        {entry.installedBytes === null ? t('notReported') : t('reported')}
                      </small>
                    </span>
                    <span className="app-space-size app-space-green">
                      {formatBytes(entry.cacheBytes)}
                      <small>{t(entry.rules.length ? 'reviewAvailable' : 'noMatchedCache')}</small>
                    </span>
                  </button>
                ))}
                {!entries.length && (
                  <p className="app-space-empty">
                    {t(report.entries.length ? 'noMatches' : 'noApps')}
                  </p>
                )}
              </div>
            </section>
            {selected && (
              <aside className="app-space-detail">
                <span className="app-space-detail-kicker">{t('breakdown')}</span>
                <h2>{selected.name}</h2>
                <p>{selected.publisher || t('knownCacheOwner')}</p>
                <div className="app-space-breakdown">
                  <div>
                    <span>
                      <HardDrive size={17} />
                      {t('installed')}
                    </span>
                    <strong>
                      {selected.installedBytes === null
                        ? t('unknown')
                        : formatBytes(selected.installedBytes)}
                    </strong>
                    <small>{t('installedNote')}</small>
                  </div>
                  <div>
                    <span>
                      <Sparkles size={17} />
                      {t('cache')}
                    </span>
                    <strong className="app-space-green">{formatBytes(selected.cacheBytes)}</strong>
                    <small>{t('files', { count: selected.cacheItems })}</small>
                  </div>
                </div>
                <p className="app-space-detail-note">{t('personalNote')}</p>
                <button
                  className="app-space-primary"
                  disabled={busy || reviewing || !selected.rules.length}
                  onClick={() => review(selected)}
                >
                  {reviewing ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Sparkles size={16} />
                  )}{' '}
                  {t(reviewing ? 'preparing' : 'review')}
                  <ArrowRight size={16} />
                </button>
                <p className="app-space-detail-note">{t('reviewNote')}</p>
                {selected.programId && (
                  <button
                    className="app-space-secondary"
                    disabled={busy || reviewing}
                    onClick={() => {
                      useUninstallerStore.getState().setSearchQuery(selected.name)
                      navigate('/uninstaller')
                    }}
                  >
                    <Package size={16} />
                    {t('manageApp')}
                    <ArrowRight size={16} />
                  </button>
                )}
              </aside>
            )}
          </div>
        </>
      )}
    </div>
  )
}
