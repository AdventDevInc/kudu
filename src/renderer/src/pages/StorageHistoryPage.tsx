import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/layout/PageHeader'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { formatBytes } from '@/lib/utils'
import type { StorageScope } from '@shared/storage-history'

export function StorageHistoryPage() {
  const { t } = useTranslation('disk')
  const [scopeId, setScopeId] = useState(''),
    [offset, setOffset] = useState(0)
  const [data, setData] = useState<Awaited<
    ReturnType<typeof window.kudu.storageHistoryList>
  > | null>(null)
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [before, setBefore] = useState(''),
    [after, setAfter] = useState(''),
    [page, setPage] = useState(0)
  const [comparison, setComparison] = useState<Awaited<
    ReturnType<typeof window.kudu.storageHistoryCompare>
  > | null>(null)
  const [deleting, setDeleting] = useState<{ id: string; scope: boolean } | null>(null)
  const refresh = useCallback(async () => {
    const result = await window.kudu.storageHistoryList(scopeId, offset)
    setData(result)
    if (!scopeId && result.scopes[0]) setScopeId(result.scopes[0].id)
  }, [scopeId, offset])
  useEffect(() => {
    let mounted = true
    const read = async () => {
      try {
        const result = await window.kudu.storageHistoryList(scopeId, offset)
        if (mounted) {
          setData(result)
          if (!scopeId && result.scopes[0]) setScopeId(result.scopes[0].id)
        }
      } catch (e) {
        if (mounted) setError(e instanceof Error ? e.message : t('storage.loadError'))
      }
    }
    void read()
    const timer = setInterval(() => void read(), 5000)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [scopeId, offset, t])
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await action()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('storage.actionError'))
    } finally {
      setBusy(false)
    }
  }
  const compare = async (nextPage = 0) => {
    setPage(nextPage)
    await run(async () =>
      setComparison(await window.kudu.storageHistoryCompare(before, after, nextPage))
    )
  }
  const button = 'rounded-lg border px-3 py-2 text-sm disabled:opacity-40'
  const scope = data?.scopes.find((s) => s.id === scopeId)
  const capture = data?.capture
  return (
    <div className="space-y-5">
      <PageHeader title={t('storage.title')} description={t('storage.description')} />
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        {t('storage.privacy')}
      </p>
      <div className="flex flex-wrap gap-3 items-center">
        <button
          className={button}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const added = await window.kudu.storageHistoryAdd()
              if (added) {
                setScopeId(added.id)
                setOffset(0)
              }
            })
          }
        >
          {t('storage.add')}
        </button>
        <label>
          {t('storage.folder')}{' '}
          <select
            className="rounded-lg border bg-transparent px-3 py-2"
            value={scopeId}
            onChange={(e) => {
              setScopeId(e.target.value)
              setOffset(0)
              setBefore('')
              setAfter('')
              setComparison(null)
            }}
          >
            <option value="">{t('storage.choose')}</option>
            {data?.scopes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <Link className="underline text-sm" to="/disk">
          {t('storage.overview')}
        </Link>
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-red-500 p-3">
          {error}
        </p>
      )}
      {scope && (
        <>
          <div className="rounded-xl border p-4 space-y-4">
            <p className="break-all font-mono text-xs">{scope.path}</p>
            <div className="flex flex-wrap gap-3">
              <button
                className={button}
                disabled={busy || !!capture}
                onClick={() =>
                  void run(async () => {
                    await window.kudu.storageHistoryCapture(scope.id)
                    setOffset(0)
                  })
                }
              >
                {t('storage.capture')}
              </button>
              <button
                className={button}
                disabled={busy || !!capture}
                onClick={() => setDeleting({ id: scope.id, scope: true })}
              >
                {t('storage.removeFolder')}
              </button>
            </div>
            <ScopeSettings
              key={scope.id}
              scope={scope}
              disabled={busy}
              save={(config) => run(() => window.kudu.storageHistoryConfigure(scope.id, config))}
            />
          </div>
          {capture && (
            <div className="rounded-xl border p-4 flex flex-wrap gap-4 items-center" role="status">
              <span>
                {t('storage.capturing', { time: new Date(capture.startedAt).toLocaleTimeString() })}
              </span>
              <button
                className={button}
                onClick={() =>
                  void window.kudu.storageHistoryCancel().catch((e) => setError(String(e)))
                }
              >
                {t('storage.cancel')}
              </button>
            </div>
          )}
          <div className="rounded-xl border p-4 space-y-2">
            <h2 className="font-semibold">{t('storage.projection')}</h2>
            {data?.projection ? (
              <>
                <p>
                  {t('storage.projectionValue', {
                    days: Math.round(data.projection.daysRemaining),
                    growth: formatBytes(data.projection.bytesPerDay)
                  })}
                </p>
                <p className="text-sm">
                  {t('storage.projectionRange', {
                    min: Math.round(data.projection.earliestDays),
                    max: Math.round(data.projection.latestDays),
                    count: data.projection.observations
                  })}
                </p>
              </>
            ) : (
              <p className="text-sm">{t('storage.noProjection')}</p>
            )}
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {t('storage.projectionCaution')}
            </p>
          </div>
          <section className="space-y-3">
            <h2 className="font-semibold">{t('storage.snapshots')}</h2>
            {!data?.snapshots.length && <p>{t('storage.empty')}</p>}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="p-2">{t('storage.time')}</th>
                    <th>{t('storage.coverage')}</th>
                    <th>{t('storage.logicalSize')}</th>
                    <th>{t('storage.free')}</th>
                    <th>{t('storage.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.snapshots.map((s) => (
                    <tr key={s.id} className="border-b">
                      <td className="p-2">
                        {new Date(s.createdAt).toLocaleString()}
                        <p className="text-xs">
                          {t('storage.duration', { seconds: Math.round(s.durationMs / 1000) })}
                        </p>
                      </td>
                      <td>
                        {t('storage.status.' + s.status)}
                        <p className="text-xs">{s.reason}</p>
                        {s.skipped > 0 && (
                          <p className="text-xs">{t('storage.skipped', { count: s.skipped })}</p>
                        )}
                      </td>
                      <td>
                        {s.status === 'unavailable'
                          ? t('storage.unavailable')
                          : formatBytes(s.totalBytes)}
                        {s.status === 'partial' && '+'}
                      </td>
                      <td>
                        {s.volumeFree === null
                          ? t('storage.unavailable')
                          : formatBytes(s.volumeFree)}
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-2 py-2">
                          <button
                            className={button}
                            disabled={busy}
                            onClick={() => {
                              setBefore(s.id)
                              setComparison(null)
                            }}
                          >
                            {before === s.id ? t('storage.beforeSelected') : t('storage.before')}
                          </button>
                          <button
                            className={button}
                            disabled={busy}
                            onClick={() => {
                              setAfter(s.id)
                              setComparison(null)
                            }}
                          >
                            {after === s.id ? t('storage.afterSelected') : t('storage.after')}
                          </button>
                          <button
                            className={button}
                            disabled={busy}
                            onClick={() => void run(() => window.kudu.storageHistoryExport(s.id))}
                          >
                            {t('storage.export')}
                          </button>
                          <button
                            className={button}
                            disabled={busy || !!capture}
                            onClick={() => setDeleting({ id: s.id, scope: false })}
                          >
                            {t('storage.delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!!data?.total && (
              <div className="flex gap-3 items-center">
                <button
                  className={button}
                  disabled={busy || offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 50))}
                >
                  {t('storage.previous')}
                </button>
                <span>
                  {offset + 1}–{Math.min(offset + 50, data.total)} / {data.total}
                </span>
                <button
                  className={button}
                  disabled={busy || offset + 50 >= data.total}
                  onClick={() => setOffset(offset + 50)}
                >
                  {t('storage.next')}
                </button>
              </div>
            )}
          </section>
          <section className="rounded-xl border p-4 space-y-3">
            <h2 className="font-semibold">{t('storage.compare')}</h2>
            <p className="text-sm">{t('storage.compareHint')}</p>
            <button
              className={button}
              disabled={busy || !before || !after || before === after}
              onClick={() => void compare()}
            >
              {t('storage.compare')}
            </button>
            {comparison && !comparison.comparable && (
              <p role="status">{t('storage.comparisonReason.' + comparison.reason)}</p>
            )}
            {comparison?.comparable && (
              <>
                <p className="font-semibold">
                  {t('storage.totalChange')}: {comparison.delta! >= 0 ? '+' : '−'}
                  {formatBytes(Math.abs(comparison.delta!))}
                </p>
                <p className="text-xs">{t('storage.overlap')}</p>
                <div className="overflow-auto">
                  <table className="w-full text-sm text-left">
                    <thead>
                      <tr className="border-b">
                        <th className="p-2">{t('storage.folder')}</th>
                        <th>{t('storage.change')}</th>
                        <th>{t('storage.before')}</th>
                        <th>{t('storage.after')}</th>
                        <th>{t('storage.delta')}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.rows.map((row) => (
                        <tr className="border-b" key={row.path}>
                          <td className="p-2 break-all max-w-sm">{row.path}</td>
                          <td>{t('storage.changeType.' + row.change)}</td>
                          <td>{row.before === null ? '—' : formatBytes(row.before)}</td>
                          <td>{row.after === null ? '—' : formatBytes(row.after)}</td>
                          <td
                            style={{ color: row.delta > 0 ? 'var(--accent)' : 'var(--text-muted)' }}
                          >
                            {row.delta >= 0 ? '+' : '−'}
                            {formatBytes(Math.abs(row.delta))}
                          </td>
                          <td>
                            <button
                              className={button}
                              disabled={busy || row.after === null}
                              onClick={() =>
                                void run(() => window.kudu.storageHistoryOpen(after, row.path))
                              }
                            >
                              {t('storage.open')}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!comparison.rows.length && <p>{t('storage.noChanges')}</p>}
                <div className="flex gap-3">
                  <button
                    className={button}
                    disabled={busy || page === 0}
                    onClick={() => void compare(Math.max(0, page - 50))}
                  >
                    {t('storage.previous')}
                  </button>
                  <button
                    className={button}
                    disabled={busy || page + 50 >= comparison.total}
                    onClick={() => void compare(page + 50)}
                  >
                    {t('storage.next')}
                  </button>
                </div>
                <Link className="underline text-sm" to="/cleaner">
                  {t('storage.openCleaner')}
                </Link>
                <span className="px-2">·</span>
                <Link className="underline text-sm" to="/history">
                  {t('storage.openActivity')}
                </Link>
              </>
            )}
          </section>
        </>
      )}
      <ConfirmDialog
        open={!!deleting}
        title={t('storage.delete')}
        description={deleting?.scope ? t('storage.deleteScopeConfirm') : t('storage.deleteConfirm')}
        confirmLabel={t('storage.delete')}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const item = deleting!
          setDeleting(null)
          void run(async () => {
            await window.kudu.storageHistoryDelete(item.id, item.scope)
            setBefore('')
            setAfter('')
            setComparison(null)
            setOffset(0)
            if (item.scope) setScopeId('')
          })
        }}
      />
    </div>
  )
}

function ScopeSettings({
  scope,
  disabled,
  save
}: {
  scope: StorageScope
  disabled: boolean
  save: (
    config: Pick<StorageScope, 'daily' | 'growthAlertBytes' | 'freeAlertPercent'>
  ) => Promise<void>
}) {
  const { t } = useTranslation('disk')
  const [daily, setDaily] = useState(scope.daily),
    [growth, setGrowth] = useState(
      scope.growthAlertBytes === null ? '' : String(scope.growthAlertBytes / 1073741824)
    ),
    [free, setFree] = useState(
      scope.freeAlertPercent === null ? '' : String(scope.freeAlertPercent)
    )
  return (
    <div className="space-y-3 text-sm">
      <label className="flex gap-2 items-center">
        <input type="checkbox" checked={daily} onChange={(e) => setDaily(e.target.checked)} />
        {t('storage.daily')}
      </label>
      <p className="text-xs">{t('storage.dailyHint')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          {t('storage.growthAlert')}
          <input
            className="block rounded-lg border px-3 py-2 bg-transparent"
            type="number"
            min={0.01}
            max={900000}
            step={0.01}
            value={growth}
            onChange={(e) => setGrowth(e.target.value)}
          />
        </label>
        <label>
          {t('storage.freeAlert')}
          <input
            className="block rounded-lg border px-3 py-2 bg-transparent"
            type="number"
            min={1}
            max={100}
            step={1}
            value={free}
            onChange={(e) => setFree(e.target.value)}
          />
        </label>
      </div>
      <button
        className="rounded-lg border px-3 py-2 disabled:opacity-40"
        disabled={disabled}
        onClick={() =>
          void save({
            daily,
            growthAlertBytes: growth ? Math.round(Number(growth) * 1073741824) : null,
            freeAlertPercent: free ? Number(free) : null
          })
        }
      >
        {t('storage.save')}
      </button>
    </div>
  )
}
