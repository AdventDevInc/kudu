import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'
import type { CleanupReceipt, CleanupReceiptItem } from '@shared/cleanup-receipts'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { formatBytes } from '@/lib/utils'

type Receipt = CleanupReceipt & { retryable: number }
export function CleanupReceipts() {
  const { t } = useTranslation('history')
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [details, setDetails] = useState<{ items: CleanupReceiptItem[]; total: number }>({
    items: [],
    total: 0
  })
  const [retry, setRetry] = useState<Receipt | null>(null)
  const [clear, setClear] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      setReceipts(await window.kudu.cleanupReceipts())
      setError('')
    } catch {
      setError(t('receipts.loadError'))
    }
  }, [t])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    let cancelled = false
    setDetails({ items: [], total: 0 })
    if (selected)
      window.kudu
        .cleanupReceiptDetails(selected, page)
        .then((data) => {
          if (!cancelled) setDetails(data)
        })
        .catch(() => {
          if (!cancelled) setError(t('receipts.loadError'))
        })
    return () => {
      cancelled = true
    }
  }, [selected, page, t])
  const receipt = receipts.find((r) => r.id === selected)
  const button = 'rounded-lg border px-3 py-2 text-sm disabled:opacity-40'
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('receipts.actionError'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-4" aria-label={t('receipts.title')}>
      <div className="flex flex-wrap items-center gap-3">
        <button className={button} onClick={() => void load()}>
          {t('receipts.refresh')}
        </button>
        <button
          className={button}
          disabled={busy || (!receipts.length && !error)}
          onClick={() => setClear(true)}
        >
          {t('clearButton')}
        </button>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {t('receipts.description')}
        </p>
      </div>
      {error && <p role="alert">{error}</p>}
      {!receipts.length && !error && <p>{t('receipts.empty')}</p>}
      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <div className="max-h-[650px] space-y-2 overflow-auto">
          {receipts.map((r) => (
            <button
              key={r.id}
              className="w-full rounded-xl border p-3 text-left text-sm"
              aria-pressed={selected === r.id}
              onClick={() => {
                setSelected(r.id)
                setPage(0)
              }}
            >
              <b>{new Date(r.startedAt).toLocaleString()}</b>
              <div>{r.categories.map((c) => c.name).join(', ')}</div>
              <div>
                {formatBytes(r.removedBytes)} · {r.origin}
              </div>
              <div>{t(r.failed || r.skipped ? 'receipts.withIssues' : 'receipts.complete')}</div>
            </button>
          ))}
        </div>
        {receipt && (
          <div className="min-w-0 space-y-4 rounded-xl border p-4">
            <h2 className="text-lg font-semibold">{t('receipts.title')}</h2>
            <p>
              {t('receipts.selectionContext', {
                found: receipt.found ?? '—',
                unselected: receipt.unselected ?? '—'
              })}
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {(['selected', 'attempted', 'deleted', 'skipped', 'failed'] as const).map((key) => (
                <div key={key}>
                  <p className="text-sm">{t('receipts.' + key)}</p>
                  <b className="text-xl">{receipt[key].toLocaleString()}</b>
                </div>
              ))}
            </div>
            <p>{t('receipts.bytes', { size: formatBytes(receipt.removedBytes) })}</p>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('receipts.units')}
            </p>
            {receipt.volumeChanges?.map((volume) => (
              <p key={volume.volume}>
                {t('receipts.volumeDelta', {
                  volume: volume.volume,
                  size: (volume.delta < 0 ? '−' : '+') + formatBytes(Math.abs(volume.delta))
                })}
              </p>
            ))}
            {!!receipt.unknownSizeItems && (
              <p>{t('receipts.unknownSize', { count: receipt.unknownSizeItems })}</p>
            )}
            {receipt.parentId && (
              <p>
                {t('receipts.retryOf')}{' '}
                <button
                  className="underline"
                  onClick={() => {
                    setSelected(receipt.parentId!)
                    setPage(0)
                  }}
                >
                  {receipt.parentId}
                </button>
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                className={button}
                disabled={busy}
                onClick={() => void run(() => window.kudu.cleanupReceiptExport(receipt.id))}
              >
                {t('receipts.export')}
              </button>
              <button
                className={button}
                disabled={busy || !receipt.retryable}
                onClick={() => setRetry(receipt)}
              >
                {t('receipts.retry', { count: receipt.retryable })}
              </button>
              <Link className={button} to="/cleaner">
                {t('receipts.rescan')}
              </Link>
            </div>
            <p className="text-sm">{t('receipts.retryLifetime')}</p>
            {!receipt.pathLogging && <p className="text-sm">{t('receipts.pathsOff')}</p>}
            <div>
              {receipt.reasons.map((r) => (
                <p key={r.reason}>
                  {r.reason}: {r.count.toLocaleString()}
                </p>
              ))}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th>{t('receipts.item')}</th>
                    <th>{t('receipts.outcome')}</th>
                    <th>{t('receipts.reason')}</th>
                    <th>{t('receipts.removed')}</th>
                  </tr>
                </thead>
                <tbody>
                  {details.items.map((item) => (
                    <tr key={item.id} className="border-t">
                      <td className="max-w-xs break-all py-2">{item.path ?? item.category}</td>
                      <td>{t('receipts.' + item.outcome)}</td>
                      <td className="break-all">{item.reason || '—'}</td>
                      <td>{formatBytes(item.removedBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-3">
              <button className={button} disabled={!page} onClick={() => setPage(page - 1)}>
                {t('receipts.previous')}
              </button>
              <span>
                {page + 1} / {Math.max(1, Math.ceil(details.total / 50))}
              </span>
              <button
                className={button}
                disabled={(page + 1) * 50 >= details.total}
                onClick={() => setPage(page + 1)}
              >
                {t('receipts.next')}
              </button>
            </div>
            {!!receipt.detailsTruncated && (
              <p>{t('receipts.truncated', { count: receipt.detailsTruncated })}</p>
            )}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={!!retry}
        onCancel={() => setRetry(null)}
        title={t('receipts.retryTitle')}
        description={t('receipts.retryDescription')}
        confirmLabel={t('receipts.retryConfirm')}
        onConfirm={() => {
          const id = retry!.id
          setRetry(null)
          void run(async () => {
            const result = await window.kudu.cleanupReceiptRetry(id)
            if (result.receiptSaved === false) throw new Error(t('receipts.saveError'))
            if (result.receiptId) {
              setSelected(result.receiptId)
              setPage(0)
            }
          })
        }}
      />
      <ConfirmDialog
        open={clear}
        onCancel={() => setClear(false)}
        title={t('receipts.clearTitle')}
        description={t('receipts.clearDescription')}
        confirmLabel={t('clearButton')}
        onConfirm={() => {
          setClear(false)
          setSelected(null)
          void run(() => window.kudu.cleanupReceiptsClear())
        }}
      />
    </section>
  )
}
