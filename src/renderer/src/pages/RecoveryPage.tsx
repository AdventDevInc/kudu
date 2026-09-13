import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/layout/PageHeader'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { formatBytes } from '@/lib/utils'
import type { RecoveryEntry } from '@shared/recovery'

export function RecoveryPage() {
  const { t } = useTranslation('history')
  const [data, setData] = useState<Awaited<ReturnType<typeof window.kudu.recoveryList>> | null>(
    null
  )
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [remove, setRemove] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<RecoveryEntry | null>(null)
  const refresh = useCallback(async () => {
    try {
      setData(await window.kudu.recoveryList(offset))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : t('recovery.loadError'))
    }
  }, [offset, t])
  useEffect(() => {
    void refresh()
  }, [refresh])
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await action()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('recovery.failed'))
    } finally {
      setBusy(false)
    }
  }
  const button = 'rounded-lg border px-3 py-2 text-sm disabled:opacity-40'
  return (
    <div className="p-8 space-y-5">
      <PageHeader title={t('recovery.title')} description={t('recovery.description')} />
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        {t('recovery.limits')}
      </p>
      <div className="flex gap-3">
        <button className={button} disabled={busy} onClick={() => void refresh()}>
          {t('recovery.refresh')}
        </button>
        <button
          className={button}
          disabled={busy || !data?.total}
          onClick={() => void run(() => window.kudu.recoveryExport())}
        >
          {t('recovery.export')}
        </button>
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-red-500 p-3">
          {error}
        </p>
      )}
      {data?.gameMode && (data.gameMode.active || data.gameMode.pendingRestore) && (
        <div className="rounded-xl border p-4">
          <h2 className="font-semibold">{t('recovery.gameMode')}</h2>
          <p>{data.gameMode.pendingReason || t('recovery.gameModeDescription')}</p>
          <Link className="underline" to="/game-mode">
            {t('recovery.openGameMode')}
          </Link>
        </div>
      )}
      {data && !data.entries.length && !data.unreadable.length && <p>{t('recovery.empty')}</p>}
      <div className="space-y-3">
        {data?.unreadable.map((id) => (
          <article key={id} className="rounded-xl border p-4">
            <p className="text-sm">{t('recovery.unreadable')}</p>
            <button className={button + ' mt-3'} disabled={busy} onClick={() => setRemove(id)}>
              {t('recovery.remove')}
            </button>
          </article>
        ))}
        {data?.entries.map((entry) => (
          <article key={entry.id} className="rounded-xl border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">{entry.label}</h2>
                <p className="text-sm">
                  {entry.source} · {new Date(entry.createdAt).toLocaleString()}
                </p>
              </div>
              <span className="rounded-full border px-3 py-1 text-sm">
                {t('recovery.status.' + entry.status)}
              </span>
            </div>
            <p className="my-2 break-all font-mono text-xs">
              {entry.target.kind === 'registry-dword'
                ? entry.target.key + ' / ' + entry.target.name
                : entry.target.name}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <b className="text-sm">{t('recovery.before')}</b>
                <pre className="overflow-auto text-sm">
                  {entry.before === null
                    ? t('recovery.absent')
                    : JSON.stringify(entry.before, null, 2)}
                </pre>
              </div>
              <div>
                <b className="text-sm">{t('recovery.after')}</b>
                <pre className="overflow-auto text-sm">
                  {entry.after === null
                    ? t('recovery.absent')
                    : JSON.stringify(entry.after, null, 2)}
                </pre>
              </div>
            </div>
            {entry.error && (
              <p className="my-2 text-sm" role="status">
                {entry.error}
              </p>
            )}
            <button
              className={button + ' mt-3'}
              disabled={busy || entry.status === 'restored'}
              onClick={() => setConfirm(entry)}
            >
              {t('recovery.restore')}
            </button>
            {entry.status !== 'pending' && (
              <button
                className={button + ' ml-3'}
                disabled={busy}
                onClick={() => setRemove(entry.id)}
              >
                {t('recovery.remove')}
              </button>
            )}
          </article>
        ))}
      </div>
      {!!data?.total && (
        <div className="flex gap-3">
          <button
            className={button}
            disabled={busy || !offset}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            {t('recovery.previous')}
          </button>
          <span>
            {offset + 1}–{Math.min(offset + 50, data.total)} / {data.total}
          </span>
          <button
            className={button}
            disabled={busy || offset + 50 >= data.total}
            onClick={() => setOffset(offset + 50)}
          >
            {t('recovery.next')}
          </button>
        </div>
      )}
      <section className="rounded-xl border p-4 space-y-3">
        <h2 className="font-semibold">{t('recovery.backups')}</h2>
        <p className="text-sm">{t('recovery.backupDescription')}</p>
        <button
          className={button}
          onClick={() => void run(() => window.kudu.recoveryOpenBackups())}
        >
          {t('recovery.openBackups')}
        </button>
        {data?.backups.map((b) => (
          <p key={b.name} className="break-all text-sm">
            {b.name} · {formatBytes(b.size)} · {new Date(b.modifiedAt).toLocaleString()}
          </p>
        ))}
      </section>
      <ConfirmDialog
        open={!!remove}
        onCancel={() => setRemove(null)}
        title={t('recovery.remove')}
        description={t('recovery.removeDescription')}
        confirmLabel={t('recovery.remove')}
        onConfirm={() => {
          const id = remove!
          setRemove(null)
          void run(() => window.kudu.recoveryRemove(id))
        }}
      />
      <ConfirmDialog
        open={!!confirm}
        onCancel={() => setConfirm(null)}
        title={t('recovery.confirmTitle')}
        description={t('recovery.confirmDescription')}
        confirmLabel={t('recovery.restore')}
        onConfirm={() => {
          const id = confirm!.id
          setConfirm(null)
          void run(() => window.kudu.recoveryRestore(id))
        }}
      />
    </div>
  )
}
