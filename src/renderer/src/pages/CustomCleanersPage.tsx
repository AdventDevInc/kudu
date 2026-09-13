import '@/components/shared/feature-layout.css'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { FolderCog, Search, Plus } from 'lucide-react'
import { EmptyState } from '@/components/shared/EmptyState'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { formatBytes } from '@/lib/utils'
import type {
  CustomCleanerRule,
  CustomCleanerPreview,
  CustomCleanerReceipt
} from '@shared/custom-cleaners'
const button = 'feature-button'
const panel = 'feature-card space-y-4'
const field = 'feature-field mt-1 block w-full'
const initial = (platform: CustomCleanerRule['platform']): CustomCleanerRule => ({
  version: 1,
  id: '',
  name: '',
  description: '',
  platform,
  root: '',
  patterns: ['*.tmp'],
  excludePatterns: [],
  excludeDirectories: [],
  minAgeDays: 7,
  maxDepth: 0,
  enabled: false
})

export function CustomCleanersPage() {
  const { t } = useTranslation('customCleaners')
  const definitionRef = useRef<HTMLElement>(null)
  const previewRef = useRef<HTMLElement>(null)
  const [platform, setPlatform] = useState<CustomCleanerRule['platform']>('win32')
  const [rules, setRules] = useState<CustomCleanerRule[]>([])
  const [draft, setDraft] = useState<CustomCleanerRule>(initial('win32'))
  const [preview, setPreview] = useState<CustomCleanerPreview | null>(null)
  const [saved, setSaved] = useState(false)
  const [page, setPage] = useState(0)
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<'clean' | 'remove' | null>(null)
  const [receipt, setReceipt] = useState<CustomCleanerReceipt | null>(null)
  const [json, setJson] = useState('')
  useEffect(() => {
    if (preview?.token) {
      previewRef.current?.focus({ preventScroll: true })
      previewRef.current?.scrollIntoView({ block: 'start' })
    }
  }, [preview?.token])
  const refresh = async () => setRules(await window.kudu.customCleanersList())
  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    let done = false
    void Promise.all([window.kudu.customCleanersList(), window.kudu.platformInfo()])
      .then(([list, info]) => {
        if (!done) {
          setRules(list)
          setLoaded(true)
          setPlatform(info.platform)
          setDraft(initial(info.platform))
        }
      })
      .catch((e) => {
        if (!done) setError(String(e))
      })
    return () => {
      done = true
    }
  }, [])
  const change = (value: Partial<CustomCleanerRule>) => {
    setDraft((current) => ({ ...current, ...value }))
    setPreview(null)
    setSaved(false)
    setConfirm(null)
    setReceipt(null)
  }
  const open = (rule: CustomCleanerRule) => {
    definitionRef.current?.scrollIntoView({ block: 'start' })
    setDraft(rule)
    setPreview(null)
    setSaved(false)
    setReceipt(null)
    setConfirm(null)
    setJson('')
  }
  const scan = async (rule: CustomCleanerRule) => {
    setScanning(true)
    try {
      const p = await window.kudu.customCleanersPreview({
        ...rule,
        name: rule.name.trim(),
        description: rule.description.trim(),
        patterns: rule.patterns.map((x) => x.trim()).filter(Boolean),
        excludePatterns: rule.excludePatterns.map((x) => x.trim()).filter(Boolean),
        excludeDirectories: rule.excludeDirectories.map((x) => x.trim()).filter(Boolean)
      })
      setDraft(p.rule)
      setPreview(p)
      setPage(0)
      setSaved(false)
      setReceipt(null)
      setConfirm(null)
    } finally {
      setScanning(false)
    }
  }
  return (
    <div className="feature-page feature-layout space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        action={
          <Link className={button} to="/cleaner">
            {t('openCleaner')}
          </Link>
        }
      />
      {error && (
        <div role="alert" className="rounded-lg border border-amber-500/40 p-4 text-sm">
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <section className={panel}>
        <div className="flex flex-wrap gap-2">
          <button className={button} disabled={busy} onClick={() => open(initial(platform))}>
            <Plus size={14} aria-hidden="true" />
            {t('new')}
          </button>
          <button
            className={button}
            disabled={busy}
            onClick={() =>
              void run(async () =>
                setNotice(t('imported', { count: await window.kudu.customCleanersImport() }))
              )
            }
          >
            {t('import')}
          </button>
          <button
            className={button}
            disabled={busy || !rules.length}
            onClick={() =>
              void run(async () => {
                await window.kudu.customCleanersExport()
              })
            }
          >
            {t('export')}
          </button>
        </div>
        <p className="text-xs text-[var(--text-muted)]">{t('localPrivacy')}</p>
        {loaded && !rules.length && (
          <EmptyState
            icon={FolderCog}
            title={t('empty')}
            description={t('emptyHint')}
            className="!min-h-[180px] !p-6"
          />
        )}
        <div className="grid gap-2 md:grid-cols-2">
          {rules.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-2 rounded-lg border border-[var(--border-medium)] p-3"
            >
              <button
                aria-pressed={draft.id === r.id}
                className="min-w-0 flex-1 rounded-lg p-2 text-left text-sm"
                disabled={busy}
                onClick={() => open(r)}
              >
                <strong className="block truncate">{r.name}</strong>
                <span className="text-xs text-[var(--text-muted)]">
                  {t(r.enabled ? 'enabled' : 'disabled')} · {r.platform}
                </span>
              </button>
              {r.enabled && (
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await window.kudu.customCleanersDisable(r.id)
                      if (draft.id === r.id) change({ enabled: false })
                    })
                  }
                >
                  {t('disable')}
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
      <section ref={definitionRef} className={panel}>
        <h2 className="flex items-center gap-2 font-semibold">
          <FolderCog size={18} className="text-[var(--accent)]" aria-hidden="true" />
          {t('definition')}
        </h2>
        <fieldset disabled={busy} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-sm">
              {t('name')}
              <input
                className={field}
                maxLength={80}
                value={draft.name}
                onChange={(e) => change({ name: e.target.value })}
              />
            </label>
            <label className="text-sm">
              {t('purpose')}
              <input
                className={field}
                maxLength={500}
                value={draft.description}
                onChange={(e) => change({ description: e.target.value })}
              />
            </label>
          </div>
          <label className="block text-sm">
            {t('folder')}
            <input className={field} readOnly value={draft.root} placeholder={t('chooseFolder')} />
          </label>
          <button
            className={button}
            onClick={() =>
              void run(async () => {
                const root = await window.kudu.customCleanersChoose()
                if (root) change({ root, platform })
              })
            }
          >
            {t('chooseFolder')}
          </button>
          <p className="text-xs text-[var(--text-muted)]">{t('folderSafety')}</p>
          <div className="grid gap-4 md:grid-cols-3">
            <label className="text-sm">
              {t('patterns')}
              <textarea
                className={field}
                rows={3}
                value={draft.patterns.join('\n')}
                onChange={(e) => change({ patterns: e.target.value.split('\n') })}
              />
            </label>
            <label className="text-sm">
              {t('excludePatterns')}
              <textarea
                className={field}
                rows={3}
                value={draft.excludePatterns.join('\n')}
                onChange={(e) => change({ excludePatterns: e.target.value.split('\n') })}
              />
            </label>
            <label className="text-sm">
              {t('excludeDirectories')}
              <textarea
                className={field}
                rows={3}
                value={draft.excludeDirectories.join('\n')}
                onChange={(e) => change({ excludeDirectories: e.target.value.split('\n') })}
              />
            </label>
          </div>
          <p className="text-xs text-[var(--text-muted)]">{t('patternHelp')}</p>
          <div className="flex flex-wrap gap-4">
            <label className="text-sm">
              {t('age')}
              <input
                className={field}
                type="number"
                min={1}
                max={3650}
                value={draft.minAgeDays}
                onChange={(e) => change({ minAgeDays: Number(e.target.value) })}
              />
            </label>
            <label className="text-sm">
              {t('depth')}
              <input
                className={field}
                type="number"
                min={0}
                max={8}
                value={draft.maxDepth}
                onChange={(e) => change({ maxDepth: Number(e.target.value) })}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => change({ enabled: e.target.checked })}
            />
            {t('enable')}
          </label>
          <p className="text-xs text-[var(--text-muted)]">{t('enableHelp')}</p>
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <button
            className={button + ' feature-primary'}
            disabled={
              busy ||
              !draft.root ||
              !draft.name.trim() ||
              !Number.isInteger(draft.minAgeDays) ||
              draft.minAgeDays < 1 ||
              draft.minAgeDays > 3650 ||
              !Number.isInteger(draft.maxDepth) ||
              draft.maxDepth < 0 ||
              draft.maxDepth > 8
            }
            onClick={() => void run(() => scan(draft))}
          >
            <Search size={14} aria-hidden="true" />
            {scanning ? t('scanning') : t('preview')}
          </button>
          {scanning && (
            <button
              className={button}
              onClick={() =>
                void window.kudu.customCleanersCancel().catch((e) => setError(String(e)))
              }
            >
              {t('cancelPreview')}
            </button>
          )}
          <button
            className={button}
            disabled={busy || !draft.id}
            onClick={() =>
              open({ ...draft, id: '', name: `${draft.name} (${t('copy')})`, enabled: false })
            }
          >
            {t('duplicate')}
          </button>
          {rules.some((r) => r.id === draft.id) && (
            <button className={button} disabled={busy} onClick={() => setConfirm('remove')}>
              {t('deleteRule')}
            </button>
          )}
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer">{t('manualJson')}</summary>
          <p className="my-2 text-xs text-[var(--text-muted)]">{t('manualHelp')}</p>
          <button
            className={button}
            disabled={busy}
            onClick={() => setJson(JSON.stringify(draft, null, 2))}
          >
            {t('copyToEditor')}
          </button>
          <textarea
            aria-label={t('manualJson')}
            className={`${field} font-mono text-xs`}
            rows={8}
            maxLength={131072}
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
          <button
            className={`${button} mt-2`}
            disabled={busy || !json}
            onClick={() => void run(() => scan(JSON.parse(json) as CustomCleanerRule))}
          >
            {t('previewJson')}
          </button>
        </details>
      </section>
      {preview && (
        <section ref={previewRef} tabIndex={-1} className={panel}>
          <h2 className="font-semibold">
            {t('previewSummary', {
              count: preview.itemCount,
              size: formatBytes(preview.totalSize)
            })}
          </h2>
          <p className="text-sm">
            {t('previewState', { state: t(preview.state), visited: preview.visited })}
          </p>
          <p className="text-xs text-[var(--text-muted)]">
            {t('qualification', {
              days: preview.rule.minAgeDays,
              patterns: preview.rule.patterns.join(', ')
            })}
          </p>
          {preview.warnings.map((w) => (
            <p key={w} className="text-sm text-amber-500">
              {w}
            </p>
          ))}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>{t('file')}</th>
                  <th>{t('size')}</th>
                  <th>{t('modified')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.items.map((item) => (
                  <tr key={item.id} className="border-t border-[var(--border-medium)]">
                    <td className="max-w-lg break-all py-2">{item.path}</td>
                    <td className="whitespace-nowrap px-2">{formatBytes(item.size)}</td>
                    <td className="whitespace-nowrap">
                      {new Date(item.lastModified).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.itemCount > 100 && (
            <div className="flex items-center gap-3">
              <button
                className={button}
                disabled={busy || page === 0}
                onClick={() =>
                  void run(async () => {
                    const next = page - 1
                    setPreview({
                      ...preview,
                      items: await window.kudu.customCleanersPage(preview.token, next * 100)
                    })
                    setPage(next)
                  })
                }
              >
                {t('previous')}
              </button>
              <span className="text-sm">
                {page + 1} / {Math.ceil(preview.itemCount / 100)}
              </span>
              <button
                className={button}
                disabled={busy || (page + 1) * 100 >= preview.itemCount}
                onClick={() =>
                  void run(async () => {
                    const next = page + 1
                    setPreview({
                      ...preview,
                      items: await window.kudu.customCleanersPage(preview.token, next * 100)
                    })
                    setPage(next)
                  })
                }
              >
                {t('next')}
              </button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              className={button + ' feature-primary'}
              disabled={busy || preview.state !== 'complete'}
              onClick={() =>
                void run(async () => {
                  setDraft(await window.kudu.customCleanersSave(preview.token))
                  setSaved(true)
                  setNotice(t('saved'))
                })
              }
            >
              {t('save')}
            </button>
            <button
              className={button}
              disabled={
                busy ||
                !saved ||
                !draft.enabled ||
                preview.state !== 'complete' ||
                !preview.itemCount
              }
              onClick={() => setConfirm('clean')}
            >
              {t('cleanMatched', { count: preview.itemCount })}
            </button>
          </div>
          <p className="text-xs text-[var(--text-muted)]">{t('previewLimits')}</p>
        </section>
      )}
      <ConfirmDialog
        open={!!confirm}
        variant="danger"
        title={t(confirm === 'clean' ? 'cleanMatched' : 'deleteRule', {
          count: preview?.itemCount ?? 0
        })}
        description={t(confirm === 'clean' ? 'confirmClean' : 'confirmDelete', {
          count: preview?.itemCount ?? 0,
          size: formatBytes(preview?.totalSize ?? 0),
          name: draft.name
        })}
        confirmLabel={t('confirm')}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const action = confirm
          setConfirm(null)
          void run(async () => {
            if (action === 'clean' && preview) {
              setReceipt(await window.kudu.customCleanersClean(preview.token))
              setPreview(null)
              setSaved(false)
            } else {
              await window.kudu.customCleanersRemove(draft.id)
              open(initial(platform))
            }
          })
        }}
      />
      {receipt && (
        <section className={panel}>
          <h2 className="font-semibold">{t('result')}</h2>
          <p className="text-sm">
            {t('resultCounts', {
              selected: receipt.selected,
              deleted: receipt.result.filesDeleted,
              skipped: receipt.result.filesSkipped,
              size: formatBytes(receipt.result.totalCleaned)
            })}
          </p>
          {receipt.result.errors.length > 0 && (
            <>
              <p className="text-sm">{t('issues')}</p>
              <ul className="max-h-56 overflow-auto text-xs space-y-2">
                {receipt.result.errors.slice(0, 100).map((e, i) => (
                  <li key={i} className="break-all">
                    {e.path}: {e.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
          <Link to="/history" className="text-sm underline">
            {t('history')}
          </Link>
        </section>
      )}
    </div>
  )
}
