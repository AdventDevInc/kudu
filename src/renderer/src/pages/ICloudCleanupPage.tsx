import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { usePlatform } from '@/hooks/usePlatform'
import {
  ICLOUD_SERVICES,
  type DeviceBackupScan,
  type DeviceBackupRemoval,
  type ICloudServiceStatus
} from '@shared/icloud-cleanup'

const button = 'rounded-xl border px-3 py-2 text-[13px] font-medium disabled:opacity-50'
const surface = { background: 'var(--card-bg)', borderColor: 'var(--border-default)' }

export function ICloudCleanupPage() {
  const { t, i18n } = useTranslation('settings')
  const { platform } = usePlatform()
  const [tab, setTab] = useState<'services' | 'cloudBackups' | 'localBackups'>('services')
  const [services, setServices] = useState<ICloudServiceStatus[]>([])
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [scan, setScan] = useState<DeviceBackupScan | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [result, setResult] = useState<DeviceBackupRemoval | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [phrase, setPhrase] = useState('')
  const [disconnected, setDisconnected] = useState(false)
  const expectedPhrase = i18n.language.startsWith('fr') ? 'SUPPRIMER' : 'DELETE'

  const refreshServices = useCallback(
    async () => setServices(await window.kudu.icloudServices()),
    []
  )
  useEffect(() => {
    if (platform === 'darwin') refreshServices().catch((error) => setError(String(error)))
  }, [platform, refreshServices])

  async function run(action: () => Promise<unknown>) {
    setError('')
    setBusy(true)
    try {
      await action()
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }

  function open(target: Parameters<typeof window.kudu.icloudOpen>[0], id?: string) {
    return run(() => window.kudu.icloudOpen(target, id))
  }

  const rows = scan?.items.filter((item) => selected.includes(item.id)) ?? []
  const total = rows.reduce((sum, item) => sum + item.bytes, 0)
  const formatSize = (bytes: number) =>
    new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }).format(bytes / 1024 ** 3) +
    ' Go'

  if (platform !== 'darwin') return <p>{t('icloud.macOnly')}</p>

  return (
    <div className="animate-fade-in">
      <PageHeader title={t('icloud.title')} description={t('icloud.description')} />
      <div role="note" className="mb-5 rounded-2xl border border-amber-500/60 p-5" style={surface}>
        <div className="flex items-center gap-2 font-semibold">
          <AlertTriangle aria-hidden="true" size={20} />
          {t('icloud.warningTitle')}
        </div>
        <p className="mt-2 text-[13px]">{t('icloud.warningSync')}</p>
        <p className="mt-2 text-[13px]">{t('icloud.warningRecovery')}</p>
        <button className={button + ' mt-3'} disabled={busy} onClick={() => open('guide')}>
          {t('icloud.appleGuide')}
        </button>
      </div>
      <div role="tablist" aria-label={t('icloud.title')} className="mb-4 flex flex-wrap gap-2">
        {(['services', 'cloudBackups', 'localBackups'] as const).map((value) => (
          <button
            key={value}
            role="tab"
            id={'icloud-tab-' + value}
            aria-selected={tab === value}
            aria-controls={'icloud-panel-' + value}
            disabled={busy}
            className={button}
            style={{ background: tab === value ? 'var(--bg-subtle-2)' : 'var(--card-bg)' }}
            onClick={() => {
              setTab(value)
              setError('')
            }}
          >
            {t('icloud.tabs.' + value)}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mb-4 whitespace-pre-wrap text-[13px] text-red-500">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="mb-4 text-[13px]">
          {t('icloud.working')}
        </p>
      )}
      <section
        role="tabpanel"
        id={'icloud-panel-' + tab}
        aria-labelledby={'icloud-tab-' + tab}
        aria-busy={busy}
      >
        {tab === 'services' && (
          <>
            <p className="mb-3 text-[13px]">{t('icloud.servicesHelp')}</p>
            <div className="mb-4 flex flex-wrap gap-2">
              <button className={button} disabled={busy} onClick={() => open('settings')}>
                {t('icloud.manageStorage')}
              </button>
              <button className={button} disabled={busy} onClick={() => open('drive')}>
                {t('icloud.openDrive')}
              </button>
              <button className={button} disabled={busy} onClick={() => open('recovery')}>
                {t('icloud.recovery')}
              </button>
            </div>
            <label className="mb-4 block text-[13px]">
              {t('icloud.search')}
              <input
                type="search"
                className="mt-1 block w-full rounded-xl border p-2"
                style={surface}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              {ICLOUD_SERVICES.filter(({ id }) =>
                t('icloud.names.' + id)
                  .toLocaleLowerCase()
                  .includes(search.toLocaleLowerCase())
              ).map(({ id }) => (
                <article key={id} className="rounded-2xl border p-4" style={surface}>
                  <h2 className="text-[15px] font-semibold">{t('icloud.names.' + id)}</h2>
                  <p className="my-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    {t(
                      ['findMy', 'siri', 'facetime'].includes(id)
                        ? 'icloud.accountService'
                        : 'icloud.appService'
                    )}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button className={button} disabled={busy} onClick={() => open('settings')}>
                      {t('icloud.manageInApple')}
                    </button>
                    {id === 'drive' ? (
                      <button className={button} disabled={busy} onClick={() => open('drive')}>
                        {t('icloud.openDrive')}
                      </button>
                    ) : (
                      <button
                        className={button}
                        disabled={
                          busy || !services.find((service) => service.id === id)?.canOpenApp
                        }
                        onClick={() => open('app', id)}
                      >
                        {t('icloud.openApp')}
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </>
        )}

        {tab === 'cloudBackups' && (
          <div className="rounded-2xl border p-5" style={surface}>
            <h2 className="font-semibold">{t('icloud.tabs.cloudBackups')}</h2>
            <p className="my-3 text-[13px]">{t('icloud.cloudBackupHelp')}</p>
            <ol className="mb-4 list-inside list-decimal space-y-2 text-[13px]">
              <li>{t('icloud.cloudStep1')}</li>
              <li>{t('icloud.cloudStep2')}</li>
              <li>{t('icloud.cloudStep3')}</li>
            </ol>
            <p className="mb-4 text-[13px] font-medium">{t('icloud.cloudBackupWarning')}</p>
            <button className={button} disabled={busy} onClick={() => open('settings')}>
              {t('icloud.manageCloudBackups')}
            </button>
          </div>
        )}

        {tab === 'localBackups' && (
          <>
            <p className="mb-3 text-[13px]">{t('icloud.localHelp')}</p>
            <div className="mb-4 flex flex-wrap gap-2">
              <button
                className={button}
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    setSelected([])
                    setResult(null)
                    setScan(null)
                    setScan(await window.kudu.deviceBackupsScan())
                  })
                }
              >
                {t('icloud.scanBackups')}
              </button>
              <button className={button} disabled={busy} onClick={() => open('backups')}>
                {t('icloud.openLocalFolder')}
              </button>
              <button className={button} disabled={busy} onClick={() => open('trash')}>
                {t('icloud.openTrash')}
              </button>
            </div>
            {scan && (
              <>
                <p className="mb-3 break-all text-[12px]">{scan.root}</p>
                {scan.items.length === 0 && (
                  <p className="text-[13px]">{t('icloud.noLocalBackups')}</p>
                )}
                <div className="space-y-3">
                  {scan.items.map((item) => (
                    <article key={item.id} className="rounded-2xl border p-4" style={surface}>
                      <label className="flex items-center gap-2 text-[14px] font-semibold">
                        <input
                          type="checkbox"
                          checked={selected.includes(item.id)}
                          disabled={busy || !item.eligible}
                          onChange={(event) =>
                            setSelected((current) =>
                              event.target.checked
                                ? [...current, item.id]
                                : current.filter((id) => id !== item.id)
                            )
                          }
                        />
                        {item.deviceName}
                      </label>
                      <p className="mt-2 text-[12px]">
                        {formatSize(item.bytes)} · {item.files} {t('icloud.files')}
                        {item.modified > 0 && ' · ' + new Date(item.modified).toLocaleString()}
                      </p>
                      <p
                        className="mt-1 break-all text-[12px]"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {item.folder}
                      </p>
                      {item.reason && (
                        <p className="mt-2 text-[12px] text-red-500">{item.reason}</p>
                      )}
                    </article>
                  ))}
                </div>
                <div className="my-4 flex flex-wrap items-center gap-3">
                  <button
                    className={button}
                    disabled={busy || selected.length === 0}
                    onClick={() => {
                      setPhrase('')
                      setDisconnected(false)
                      setConfirm(true)
                    }}
                  >
                    {t('icloud.removeLocal')}
                  </button>
                  <span className="text-[13px]">
                    {t('icloud.selected', { count: rows.length, size: formatSize(total) })}
                  </span>
                </div>
              </>
            )}
            {result && (
              <div role="status" className="rounded-2xl border p-4" style={surface}>
                <p>
                  {t('icloud.removalResult', {
                    count: result.removedIds.length,
                    skipped: result.skipped.length
                  })}
                </p>
                <p className="mt-2 text-[13px]">{t('icloud.restoreHelp')}</p>
                {result.skipped.map((item) => (
                  <p key={item.id} className="mt-1 text-[12px]">
                    {item.message}
                  </p>
                ))}
                {result.recoveryPaths.map((path) => (
                  <p key={path} className="mt-2 break-all text-[12px]">
                    {t('icloud.retained', { path })}
                  </p>
                ))}
              </div>
            )}
          </>
        )}
      </section>
      <ConfirmDialog
        open={confirm}
        title={t('icloud.confirmTitle')}
        description={t('icloud.confirmDescription', {
          count: rows.length,
          size: formatSize(total)
        })}
        confirmLabel={t('icloud.confirmRemove')}
        confirmDisabled={!disconnected || phrase !== expectedPhrase || busy}
        variant="danger"
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          if (!scan || phrase !== expectedPhrase || !disconnected) return
          setConfirm(false)
          run(async () => {
            const response = await window.kudu.deviceBackupsRemove(
              scan.scanId,
              selected,
              phrase,
              disconnected
            )
            setResult(response)
            setSelected([])
            const unavailable = new Set([
              ...response.removedIds,
              ...response.skipped.map((item) => item.id)
            ])
            setScan((current) =>
              current
                ? { ...current, items: current.items.filter((item) => !unavailable.has(item.id)) }
                : current
            )
          })
        }}
      >
        <ul className="my-3 list-inside list-disc text-[13px]">
          {rows.map((item) => (
            <li key={item.id}>{item.deviceName}</li>
          ))}
        </ul>
        <label className="my-3 flex gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={disconnected}
            onChange={(event) => setDisconnected(event.target.checked)}
          />
          {t('icloud.disconnected')}
        </label>
        <label className="block text-[13px]">
          {t('icloud.typePhrase', { phrase: expectedPhrase })}
          <input
            autoComplete="off"
            className="mt-2 block w-full rounded-lg border p-2"
            style={surface}
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
          />
        </label>
        {(!disconnected || phrase !== expectedPhrase) && (
          <p className="mt-2 text-[12px]">{t('icloud.confirmRequired')}</p>
        )}
      </ConfirmDialog>
    </div>
  )
}
