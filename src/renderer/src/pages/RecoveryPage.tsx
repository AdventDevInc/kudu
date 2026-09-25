import '@/components/shared/feature-layout.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { RotateCcw } from 'lucide-react'
import { EmptyState } from '@/components/shared/EmptyState'
import { PageHeader } from '@/components/layout/PageHeader'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { formatBytes } from '@/lib/utils'
import { usePlatform } from '@/hooks/usePlatform'
import type { RecoveryEntry, RegistryBackup } from '@shared/recovery'

/** Drop Electron's "Error invoking remote method '…': Error:" prefix from IPC rejections. */
const ipcMessage = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    ''
  )

export function RecoveryPage() {
  const { t } = useTranslation('history')
  const { t: tx } = useTranslation('experience')
  const [data, setData] = useState<Awaited<ReturnType<typeof window.kudu.recoveryList>> | null>(
    null
  )
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [remove, setRemove] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<RecoveryEntry | null>(null)
  const isWin = usePlatform().platform === 'win32'
  const [registryBackups, setRegistryBackups] = useState<RegistryBackup[]>([])
  const [registryConfirm, setRegistryConfirm] = useState<RegistryBackup | null>(null)
  // Restoring a registry backup always needs elevation; null until known.
  const [elevated, setElevated] = useState<boolean | null>(null)
  useEffect(() => {
    if (!isWin) return
    window.kudu
      .elevationCheck()
      .then((value) => setElevated(!!value))
      .catch(() => setElevated(false))
  }, [isWin])
  const [registryResults, setRegistryResults] = useState<
    Record<string, { ok: boolean; message: string }>
  >({})
  // Only the newest request may update the page: a slower earlier page load must
  // not overwrite the result of a later one.
  const request = useRef(0)
  const refresh = useCallback(async () => {
    const token = ++request.current
    setLoading(true)
    try {
      const [result, registry] = await Promise.all([
        window.kudu.recoveryList(offset),
        isWin ? window.kudu.recoveryRegistryBackups() : Promise.resolve([])
      ])
      if (token !== request.current) return
      setData(result)
      setRegistryBackups(registry)
      setError('')
    } catch (e) {
      if (token !== request.current) return
      setError(e instanceof Error ? e.message : t('recovery.loadError'))
    }
    setLoading(false)
  }, [offset, t, isWin])
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
  const restoreRegistry = async (backup: RegistryBackup) => {
    setBusy(true)
    let outcome: { ok: boolean; message: string }
    try {
      const result = await window.kudu.recoveryRegistryRestore(backup.name)
      outcome = {
        ok: true,
        message: result.preRestoreBackup
          ? t('recovery.registryBackups.restored', { file: result.preRestoreBackup })
          : t('recovery.registryBackups.restoredNoBackup')
      }
    } catch (e) {
      outcome = {
        ok: false,
        message: t('recovery.registryBackups.failed', { error: ipcMessage(e) })
      }
    }
    setRegistryResults((results) => ({ ...results, [backup.name]: outcome }))
    await refresh()
    setBusy(false)
  }
  const button = 'feature-button'
  return (
    <div className="feature-page feature-layout pulse-recovery-page space-y-5">
      <PageHeader title={t('recovery.title')} description={t('recovery.description')} />
      {data && (
        <div className="pulse-recovery-overview">
          <section className="feature-card">
            <span>{tx('recovery.recorded')}</span>
            <strong>{data.total}</strong>
          </section>
          <section className="feature-card">
            <span>{tx('recovery.backups')}</span>
            {/* On Windows the list below is the registry backup list, so count that. */}
            <strong>{isWin ? registryBackups.length : data.backups.length}</strong>
          </section>
          <section className="feature-card pulse-recovery-context">
            <RotateCcw size={24} />
            <p>{tx('recovery.hint')}</p>
          </section>
        </div>
      )}
      <p className="feature-note">{t('recovery.limits')}</p>
      <div className="flex flex-wrap items-center gap-3">
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
        <div className="feature-card">
          <h2 className="font-semibold">{t('recovery.gameMode')}</h2>
          <p>{data.gameMode.pendingReason || t('recovery.gameModeDescription')}</p>
          <Link className="underline" to="/game-mode">
            {t('recovery.openGameMode')}
          </Link>
        </div>
      )}
      {loading && <p role="status">{t('recovery.loading')}</p>}
      {!loading && data && !data.entries.length && !data.unreadable.length && (
        <EmptyState
          icon={RotateCcw}
          title={t('recovery.emptyTitle')}
          description={t('recovery.empty')}
        />
      )}
      <div className="space-y-3">
        {data?.unreadable.map((id) => (
          <article key={id} className="feature-card">
            <p className="text-sm">{t('recovery.unreadable')}</p>
            <button className={button + ' mt-3'} disabled={busy} onClick={() => setRemove(id)}>
              {t('recovery.remove')}
            </button>
          </article>
        ))}
        {data?.entries.map((entry) => (
          <article key={entry.id} className="feature-card">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">{entry.label}</h2>
                <p className="text-xs text-[var(--text-muted)]">
                  {t('recovery.source.' + entry.source)} ·{' '}
                  {new Date(entry.createdAt).toLocaleString()}
                </p>
              </div>
              <span className="feature-status">{t('recovery.status.' + entry.status)}</span>
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
              className={button + ' feature-primary mt-3'}
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
            disabled={busy || loading || !offset}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            {t('recovery.previous')}
          </button>
          <span>
            {offset + 1}–{Math.min(offset + 50, data.total)} / {data.total}
          </span>
          <button
            className={button}
            disabled={busy || loading || offset + 50 >= data.total}
            onClick={() => setOffset(offset + 50)}
          >
            {t('recovery.next')}
          </button>
        </div>
      )}
      <section className="feature-card space-y-3">
        <h2 className="font-semibold">
          {t(isWin ? 'recovery.registryBackups.title' : 'recovery.backups')}
        </h2>
        <p className="text-sm">
          {t(isWin ? 'recovery.registryBackups.description' : 'recovery.backupDescription')}
        </p>
        <button
          className={button}
          disabled={busy}
          onClick={() => void run(() => window.kudu.recoveryOpenBackups())}
        >
          {t('recovery.openBackups')}
        </button>
        {!isWin &&
          data?.backups.map((b) => (
            <p key={b.name} className="break-all text-sm">
              {b.name} · {formatBytes(b.size)} · {new Date(b.modifiedAt).toLocaleString()}
            </p>
          ))}
        {isWin && !loading && !registryBackups.length && (
          <p className="text-sm">{t('recovery.registryBackups.empty')}</p>
        )}
        {registryBackups.map((backup) => (
          <RegistryBackupCard
            key={backup.name}
            backup={backup}
            result={registryResults[backup.name]}
            busy={busy}
            elevated={elevated}
            onRestore={() => setRegistryConfirm(backup)}
            onShow={() => void run(() => window.kudu.recoveryShowBackup(backup.name))}
          />
        ))}
      </section>
      <ConfirmDialog
        open={!!remove}
        variant="danger"
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
        open={!!registryConfirm}
        variant="warning"
        onCancel={() => setRegistryConfirm(null)}
        title={t('recovery.registryBackups.confirmTitle')}
        description={t('recovery.registryBackups.confirmDescription')}
        details={
          registryConfirm
            ? keyLines(registryConfirm, 50, (count) =>
                t('recovery.registryBackups.moreKeys', { count })
              ).join('\n')
            : undefined
        }
        confirmLabel={t('recovery.registryBackups.restore')}
        onConfirm={() => {
          const backup = registryConfirm!
          setRegistryConfirm(null)
          void restoreRegistry(backup)
        }}
      />
      <ConfirmDialog
        open={!!confirm}
        onCancel={() => setConfirm(null)}
        title={t('recovery.confirmTitle')}
        description={t('recovery.confirmDescription')}
        details={confirm?.label}
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

/** Up to `limit` top-level keys, plus a "+N more" line for the rest. */
function keyLines(
  backup: RegistryBackup,
  limit: number,
  more: (count: number) => string
): string[] {
  const lines = backup.keys.slice(0, limit)
  if (backup.keyCount > lines.length) lines.push(more(backup.keyCount - lines.length))
  return lines
}

function RegistryBackupCard({
  backup,
  result,
  busy,
  elevated,
  onRestore,
  onShow
}: {
  backup: RegistryBackup
  result?: { ok: boolean; message: string }
  busy: boolean
  elevated: boolean | null
  onRestore: () => void
  onShow: () => void
}) {
  const { t } = useTranslation('history')
  // The main process refuses unelevated restores; say so instead of offering one.
  const needsAdmin = backup.restorable && backup.requiresAdmin && elevated === false
  return (
    <article className="feature-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="break-all font-semibold">{backup.name}</h3>
          <p className="text-xs text-[var(--text-muted)]">
            {t('recovery.registryBackups.source.' + backup.source)} ·{' '}
            {new Date(backup.modifiedAt).toLocaleString()} · {formatBytes(backup.size)}
            {needsAdmin ? ' · ' + t('recovery.registryBackups.requiresAdmin') : ''}
          </p>
        </div>
        {backup.restorable ? (
          <button
            className="feature-button feature-primary"
            disabled={busy || needsAdmin}
            title={needsAdmin ? t('recovery.registryBackups.requiresAdmin') : undefined}
            onClick={onRestore}
          >
            {t('recovery.registryBackups.restore')}
          </button>
        ) : (
          <button className="feature-button" disabled={busy} onClick={onShow}>
            {t('recovery.registryBackups.showInFolder')}
          </button>
        )}
      </div>
      <ul className="my-2 break-all font-mono text-xs">
        {keyLines(backup, 5, (count) => t('recovery.registryBackups.moreKeys', { count })).map(
          (line) => (
            <li key={line}>{line}</li>
          )
        )}
      </ul>
      {backup.blocked && (
        <p className="text-sm">{t('recovery.registryBackups.blocked.' + backup.blocked)}</p>
      )}
      {result && (
        <p
          role={result.ok ? 'status' : 'alert'}
          className={'mt-2 text-sm' + (result.ok ? '' : ' rounded-lg border border-red-500 p-2')}
        >
          {result.message}
        </p>
      )}
    </article>
  )
}
