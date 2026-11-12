import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from './ConfirmDialog'
import type {
  MacAuditSummary,
  MacPathPlan,
  MacReading,
  MacToolAction,
  MacToolReport,
  MacToolTab
} from '@shared/mac-tools'

const tabs: MacToolTab[] = [
  'spotlight',
  'associations',
  'path',
  'battery',
  'energy',
  'animations',
  'audit'
]
const buttonClass = 'rounded-lg border px-3 py-2 text-[13px] font-medium disabled:opacity-50'
const surface = { background: 'var(--card-bg)', borderColor: 'var(--border-default)' }

export function MacToolsPanel() {
  const { t, i18n } = useTranslation('settings')
  const [tab, setTab] = useState<MacToolTab>('spotlight')
  const [reports, setReports] = useState<Partial<Record<MacToolTab, MacToolReport>>>({})
  const [volume, setVolume] = useState('/')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [audit, setAudit] = useState<MacAuditSummary | null>(null)
  const [pending, setPending] = useState<{
    description: string
    action: () => Promise<void>
  } | null>(null)

  async function execute(action: () => Promise<unknown>, success?: string) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      if (success) setNotice(success)
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }

  function apply(action: MacToolAction) {
    setPending({
      description:
        t('mac.confirm.' + action.kind) +
        ' ' +
        ('volume' in action
          ? action.volume
          : 'profile' in action
            ? t('mac.' + action.profile)
            : ''),
      action: async () => {
        await window.kudu.macToolsApply(action)
        if (action.kind !== 'associations') {
          try {
            const report = await window.kudu.macToolsRead(action.kind)
            setReports((previous) => ({ ...previous, [action.kind]: report }))
          } catch {
            /* the completed action still has a successful result */
          }
        }
      }
    })
  }

  function inspect(tool: MacToolTab) {
    return execute(async () => {
      const report = await window.kudu.macToolsRead(tool)
      setReports((previous) => ({ ...previous, [tool]: report }))
    })
  }

  function displayValue(reading: MacReading): string {
    if (tab === 'energy') {
      return reading.value
        .split('\n')
        .map((line) => {
          const match = line.match(/^(sleep|displaysleep|lowpowermode) = (\d+)$/)
          if (!match) return line
          const value =
            match[1] === 'lowpowermode'
              ? t(match[2] === '1' ? 'mac.yes' : 'mac.no')
              : match[2] + ' min'
          return t('mac.readings.' + match[1]) + ' · ' + value
        })
        .join('\n')
    }
    if (reading.value === 'default') return t('mac.default')
    if (['true', 'false'].includes(reading.value))
      return t(reading.value === 'true' ? 'mac.yes' : 'mac.no')
    if (
      tab === 'animations' &&
      ['launchanim', 'NSAutomaticWindowAnimationsEnabled'].includes(reading.label) &&
      ['0', '1'].includes(reading.value)
    ) {
      return t(reading.value === '1' ? 'mac.yes' : 'mac.no')
    }
    return reading.value
  }

  const report = reports[tab]
  return (
    <section id="macTools" tabIndex={-1} className="mb-6 rounded-2xl border p-5" style={surface}>
      <h2 className="text-[18px] font-semibold">{t('mac.title')}</h2>
      <p className="mt-2 text-[13px]" style={{ color: 'var(--text-muted)' }}>
        {t('mac.description')}
      </p>
      <div role="tablist" aria-label={t('mac.title')} className="my-4 flex flex-wrap gap-2">
        {tabs.map((value) => (
          <button
            key={value}
            id={'mac-tab-' + value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={'mac-panel-' + value}
            disabled={busy}
            className={buttonClass}
            style={{ background: tab === value ? 'var(--bg-subtle-2)' : 'var(--card-bg)' }}
            onClick={() => {
              setTab(value)
              setError('')
              setNotice('')
            }}
          >
            {t('mac.tabs.' + value)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={'mac-panel-' + tab}
        aria-labelledby={'mac-tab-' + tab}
        aria-busy={busy}
      >
        <h3 className="text-[15px] font-semibold">{t('mac.tabs.' + tab)}</h3>
        <p className="my-3 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          {t('mac.help.' + tab)}
        </p>
        {error && (
          <p role="alert" className="my-3 whitespace-pre-wrap text-[13px] text-red-500">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="my-3 break-all text-[13px]">
            {notice}
          </p>
        )}
        {busy && (
          <p role="status" className="my-3 text-[13px]">
            {t('mac.working')}
          </p>
        )}

        {tab === 'spotlight' && (
          <div className="flex flex-wrap items-center gap-3">
            <button className={buttonClass} disabled={busy} onClick={() => inspect(tab)}>
              {t('mac.inspectVolumes')}
            </button>
            <label className="text-[13px]">
              {t('mac.volume')}{' '}
              <select
                className={buttonClass}
                style={surface}
                value={volume}
                disabled={busy}
                onChange={(event) => setVolume(event.target.value)}
              >
                {(report?.volumes ?? [{ path: '/', name: 'Macintosh HD (/)' }]).map((item) => (
                  <option key={item.path} value={item.path}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className={buttonClass}
              disabled={busy}
              onClick={() => apply({ kind: 'spotlight', volume })}
            >
              {t('mac.reindex')}
            </button>
          </div>
        )}
        {tab === 'associations' && (
          <button
            className={buttonClass}
            disabled={busy}
            onClick={() => apply({ kind: 'associations' })}
          >
            {t('mac.rebuild')}
          </button>
        )}
        {tab === 'path' && (
          <MacPathEditor key="path" busy={busy} execute={execute} confirm={setPending} />
        )}
        {tab === 'battery' && (
          <button className={buttonClass} disabled={busy} onClick={() => inspect(tab)}>
            {t('mac.diagnose')}
          </button>
        )}
        {tab === 'energy' && (
          <div className="flex flex-wrap gap-3">
            <button className={buttonClass} disabled={busy} onClick={() => inspect(tab)}>
              {t('mac.current')}
            </button>
            {(['eco', 'balanced', 'restore'] as const).map((profile) => (
              <button
                key={profile}
                className={buttonClass}
                disabled={busy || (profile === 'restore' && !report?.canRestore)}
                onClick={() => apply({ kind: 'energy', profile })}
              >
                {t('mac.' + profile)}
              </button>
            ))}
          </div>
        )}
        {tab === 'animations' && (
          <div className="flex flex-wrap gap-3">
            <button className={buttonClass} disabled={busy} onClick={() => inspect(tab)}>
              {t('mac.current')}
            </button>
            {(['fast', 'reduced', 'restore'] as const).map((profile) => (
              <button
                key={profile}
                className={buttonClass}
                disabled={busy || (profile === 'restore' && !report?.canRestore)}
                onClick={() => apply({ kind: 'animations', profile })}
              >
                {t('mac.' + profile)}
              </button>
            ))}
          </div>
        )}
        {tab === 'audit' && (
          <>
            <div className="flex flex-wrap gap-3">
              <button
                className={buttonClass}
                disabled={busy}
                onClick={() =>
                  execute(async () => {
                    setAudit(await window.kudu.macAuditCreate(i18n.language))
                  })
                }
              >
                {t('mac.generate')}
              </button>
              <button
                className={buttonClass}
                disabled={busy || !audit}
                onClick={() =>
                  execute(async () => {
                    const path = await window.kudu.macAuditExport(audit!.id)
                    if (path) setNotice(t('mac.exported', { path }))
                  })
                }
              >
                {t('mac.export')}
              </button>
            </div>
            {audit && (
              <div className="mt-4 space-y-3">
                <p className="text-[12px]">{new Date(audit.createdAt).toLocaleString()}</p>
                {audit.disks.map((disk) => {
                  const percent =
                    disk.total > 0 ? Math.max(0, Math.min(100, (disk.used / disk.total) * 100)) : 0
                  return (
                    <div key={disk.label} className="text-[13px]">
                      <span>
                        {disk.label} · {percent.toFixed(1)} %
                      </span>
                      <meter
                        className="mt-1 block w-full"
                        min={0}
                        max={100}
                        value={percent}
                        aria-label={disk.label}
                      />
                    </div>
                  )
                })}
                {audit.sections.map((section) => (
                  <p key={section.title} className="text-[13px]">
                    {section.title} · {t(section.available ? 'mac.available' : 'mac.unavailable')}
                  </p>
                ))}
              </div>
            )}
          </>
        )}

        {report && (
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            {report.readings.map((reading) => (
              <div key={reading.label} className="rounded-xl border p-3" style={surface}>
                <dt className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  {t('mac.readings.' + reading.label, { defaultValue: reading.label })}
                </dt>
                <dd className="mt-1 whitespace-pre-wrap break-words text-[14px]">
                  {displayValue(reading)}
                </dd>
                {['charge', 'health'].includes(reading.label) &&
                  Number.isFinite(parseFloat(reading.value)) && (
                    <meter
                      className="mt-2 w-full"
                      min={0}
                      max={100}
                      value={parseFloat(reading.value)}
                      aria-label={reading.label}
                    />
                  )}
              </div>
            ))}
          </dl>
        )}
      </div>
      <ConfirmDialog
        open={!!pending}
        title={t('mac.confirmTitle')}
        description={pending?.description ?? ''}
        confirmLabel={t('mac.continue')}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const action = pending?.action
          setPending(null)
          if (action) execute(action, t('mac.done'))
        }}
      />
    </section>
  )
}

function MacPathEditor({
  busy,
  execute,
  confirm
}: {
  busy: boolean
  execute: (action: () => Promise<unknown>, success?: string) => Promise<void>
  confirm: (value: { description: string; action: () => Promise<void> }) => void
}) {
  const { t } = useTranslation('settings')
  const [file, setFile] = useState('.zshrc')
  const [plan, setPlan] = useState<MacPathPlan | null>(null)
  const [orders, setOrders] = useState<number[][]>([])

  function receive(value: MacPathPlan) {
    setPlan(value)
    setOrders(
      value.lines.map((line) =>
        line.parts.flatMap((part, index) =>
          ['missing', 'duplicate'].includes(part.status) ? [] : [index]
        )
      )
    )
  }

  function move(line: number, position: number, offset: number) {
    const next = orders.map((order) => [...order])
    const target = position + offset
    const previous = next[line][position]
    next[line][position] = next[line][target]
    next[line][target] = previous
    setOrders(next)
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-[13px]">
          {t('mac.shellFile')}{' '}
          <select
            value={file}
            disabled={busy}
            className={buttonClass}
            style={surface}
            onChange={(event) => {
              setFile(event.target.value)
              setPlan(null)
            }}
          >
            {['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile'].map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <button
          className={buttonClass}
          disabled={busy}
          onClick={() => execute(async () => receive(await window.kudu.macPathRead(file)))}
        >
          {t('mac.analyze')}
        </button>
      </div>
      {plan && (
        <>
          <p className="my-3 text-[13px]">
            {t('mac.pathSummary', { count: plan.lines.length, skipped: plan.skipped })}
          </p>
          {plan.lines.map((line, lineIndex) => (
            <div key={line.number} className="my-3 rounded-xl border p-3">
              <p className="text-[12px]">{t('mac.line', { number: line.number })}</p>
              <pre className="my-2 whitespace-pre-wrap break-all text-[12px]">{line.original}</pre>
              {line.parts.map((part, index) => (
                <label key={index} className="my-1 flex items-center gap-2 text-[12px]">
                  <input
                    type="checkbox"
                    disabled={busy || part.status === 'dynamic'}
                    checked={orders[lineIndex]?.includes(index)}
                    onChange={(event) =>
                      setOrders((current) =>
                        current.map((order, row) =>
                          row === lineIndex
                            ? event.target.checked
                              ? [...order, index]
                              : order.filter((item) => item !== index)
                            : order
                        )
                      )
                    }
                  />
                  <span className="break-all">
                    {part.value || t('mac.emptyEntry')} · {t('mac.pathStatus.' + part.status)}
                  </span>
                </label>
              ))}
              <p className="my-2 text-[12px] font-medium">{t('mac.proposed')}</p>
              {orders[lineIndex]?.map((index, position) => (
                <div key={index} className="my-1 flex items-center gap-2 text-[12px]">
                  <button
                    aria-label={t('mac.moveUp')}
                    className="rounded border px-2"
                    disabled={busy || position === 0}
                    onClick={() => move(lineIndex, position, -1)}
                  >
                    ↑
                  </button>
                  <button
                    aria-label={t('mac.moveDown')}
                    className="rounded border px-2"
                    disabled={busy || position === orders[lineIndex].length - 1}
                    onClick={() => move(lineIndex, position, 1)}
                  >
                    ↓
                  </button>
                  <span className="break-all">{line.parts[index].value}</span>
                </div>
              ))}
              <pre className="my-2 whitespace-pre-wrap break-all text-[12px]">
                {line.prefix +
                  line.quote +
                  orders[lineIndex].map((index) => line.parts[index].value).join(':') +
                  line.quote +
                  line.suffix}
              </pre>
            </div>
          ))}
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              className={buttonClass}
              disabled={busy || plan.lines.length === 0 || orders.some((order) => !order.length)}
              onClick={() =>
                confirm({
                  description: t('mac.confirm.path'),
                  action: async () => {
                    receive(await window.kudu.macPathApply({ file, hash: plan.hash, orders }))
                  }
                })
              }
            >
              {t('mac.applyPath')}
            </button>
            <button
              className={buttonClass}
              disabled={busy || !plan.canRestore}
              onClick={() =>
                confirm({
                  description: t('mac.confirm.restorePath'),
                  action: async () => {
                    receive(await window.kudu.macPathRestore(file))
                  }
                })
              }
            >
              {t('mac.restore')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
