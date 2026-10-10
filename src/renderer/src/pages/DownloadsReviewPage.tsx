import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  Download,
  File,
  FolderOpen,
  HardDrive,
  Package,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { formatBytes } from '@/lib/utils'
import { useDownloadsStore } from '@/stores/downloads-store'
import type { DownloadKind } from '@shared/downloads-review'

const icons = { installer: Package, archive: Archive, diskImage: HardDrive, other: File }
const fieldStyle = {
  background: 'var(--bg-subtle)',
  borderColor: 'var(--border-default)',
  color: 'var(--text-primary)'
}
export function DownloadsReviewPage() {
  const { t } = useTranslation('downloads')
  const store = useDownloadsStore()
  const [age, setAge] = useState(30)
  const [kind, setKind] = useState<DownloadKind | 'all'>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('size')
  const [confirm, setConfirm] = useState(false)
  const [shown, setShown] = useState(50)
  const files = useMemo(() => {
    const cutoff = Date.now() - age * 86400000
    return (store.result?.files ?? [])
      .filter(
        (file) =>
          (age === 0 || file.modified <= cutoff) &&
          (kind === 'all' || file.kind === kind) &&
          file.name.toLowerCase().includes(query.toLowerCase())
      )
      .sort((a, b) =>
        sort === 'size'
          ? b.size - a.size
          : sort === 'age'
            ? a.modified - b.modified
            : a.name.localeCompare(b.name)
      )
  }, [store.result, age, kind, query, sort])
  const selectedFiles = (store.result?.files ?? []).filter((file) => store.selected.has(file.id))
  const selectedBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0)
  const visibleBytes = files.reduce((sum, file) => sum + file.size, 0)
  const visible = files.slice(0, shown)
  const changeFilter = (change: () => void) => {
    store.clearSelection()
    setShown(50)
    change()
  }

  return (
    <div className="space-y-5 pb-8">
      <PageHeader
        title={t('pageTitle')}
        description={t('description')}
        showWorkflow={false}
        action={
          <button
            className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
            style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
            disabled={store.busy}
            onClick={() => {
              setShown(50)
              void store.scan()
            }}
          >
            <RefreshCw className={`h-4 w-4 ${store.busy ? 'animate-spin' : ''}`} />
            {t(
              store.phase === 'moving'
                ? 'moving'
                : store.phase === 'scanning'
                  ? 'scanning'
                  : store.result
                    ? 'rescan'
                    : 'scan'
            )}
          </button>
        }
      />
      <section className="glass-card overflow-hidden rounded-2xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="flex max-w-xl items-start gap-4">
            <div
              className="rounded-2xl p-3"
              style={{ background: 'var(--accent-muted-bg)', color: 'var(--accent)' }}
            >
              <Download className="h-7 w-7" />
            </div>
            <div>
              <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t('heroTitle')}
              </h2>
              <p
                className="mt-1 text-sm leading-relaxed"
                style={{ color: 'var(--text-secondary)' }}
              >
                {t('heroDescription')}
              </p>
            </div>
          </div>
          <div className="text-left sm:text-right">
            <p
              className="text-3xl font-semibold tracking-tight"
              style={{ color: 'var(--text-primary)' }}
            >
              {formatBytes(visibleBytes)}
            </p>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              {t('reviewCount', { count: files.length })}
            </p>
          </div>
        </div>
        <div
          className="mt-5 flex items-start gap-2 rounded-xl p-3 text-xs leading-relaxed"
          style={{ background: 'var(--accent-muted-bg)', color: 'var(--text-secondary)' }}
        >
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          {t('safety')}
        </div>
        {store.result && (
          <p className="mt-3 break-all text-xs" style={{ color: 'var(--text-muted)' }}>
            {store.result.directory}
          </p>
        )}
      </section>

      <section className="glass-card rounded-2xl p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-44 flex-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
            {t('search')}
            <div className="relative mt-1.5">
              <Search className="absolute left-3 top-3 h-4 w-4" />
              <input
                value={query}
                onChange={(e) => changeFilter(() => setQuery(e.target.value))}
                className="w-full rounded-xl border py-2.5 pl-9 pr-3 text-sm"
                style={fieldStyle}
                placeholder={t('searchPlaceholder')}
                disabled={store.busy}
              />
            </div>
          </label>
          <label className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {t('age')}
            <select
              className="mt-1.5 block rounded-xl border p-2.5 text-sm"
              style={fieldStyle}
              value={age}
              onChange={(e) => changeFilter(() => setAge(Number(e.target.value)))}
              disabled={store.busy}
            >
              {[0, 30, 90, 180, 365].map((days) => (
                <option key={days} value={days}>
                  {days ? t('olderThan', { days }) : t('anyAge')}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {t('sort')}
            <select
              className="mt-1.5 block rounded-xl border p-2.5 text-sm"
              style={fieldStyle}
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              disabled={store.busy}
            >
              <option value="size">{t('largest')}</option>
              <option value="age">{t('oldest')}</option>
              <option value="name">{t('name')}</option>
            </select>
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-2" aria-label={t('typeFilter')}>
          {(['all', 'installer', 'archive', 'diskImage', 'other'] as const).map((value) => (
            <button
              key={value}
              aria-pressed={kind === value}
              disabled={store.busy}
              className="rounded-lg border px-3 py-2 text-xs font-medium"
              style={{
                borderColor: kind === value ? 'var(--accent)' : 'var(--border-default)',
                background: kind === value ? 'var(--accent-muted-bg)' : 'transparent',
                color: kind === value ? 'var(--accent)' : 'var(--text-secondary)'
              }}
              onClick={() => changeFilter(() => setKind(value))}
            >
              {t(`kinds.${value}`)}
            </button>
          ))}
        </div>
      </section>
      {store.error && (
        <div
          role="alert"
          className="rounded-xl border p-4 text-sm"
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
        >
          {t('error')} {store.error}
        </div>
      )}
      {store.outcome && (
        <div
          role="status"
          className="glass-card rounded-xl p-4 text-sm"
          style={{ color: 'var(--text-primary)' }}
        >
          {t('outcome', { count: store.outcome.trashedIds.length })}
          {store.outcome.skippedIds.length > 0 && (
            <p className="mt-1" style={{ color: 'var(--text-secondary)' }}>
              {t('skipped', { count: store.outcome.skippedIds.length })}
            </p>
          )}
          <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
            {t('binSpace')}
          </p>
        </div>
      )}
      {store.result?.limited && (
        <p role="status" className="text-sm" style={{ color: 'var(--warning)' }}>
          {t('limited')}
        </p>
      )}
      <section
        className="glass-card overflow-hidden rounded-2xl"
        aria-label={t('files')}
        aria-busy={store.busy}
      >
        {!store.result || files.length === 0 ? (
          <div className="flex min-h-52 flex-col items-center justify-center gap-3 p-8 text-center">
            <FolderOpen className="h-9 w-9" style={{ color: 'var(--accent)' }} />
            <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>
              {t(
                store.phase === 'scanning'
                  ? 'scanning'
                  : !store.result
                    ? 'startTitle'
                    : 'emptyTitle'
              )}
            </h3>
            <p className="max-w-md text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t(!store.result ? 'startDescription' : 'emptyDescription')}
            </p>
          </div>
        ) : (
          <>
            <div
              className="flex flex-wrap justify-between gap-3 border-b p-4 text-xs"
              style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
            >
              <span>{t('showing', { count: visible.length, total: files.length })}</span>
              <button
                disabled={store.busy}
                onClick={() => store.select(visible.map((file) => file.id))}
                style={{ color: 'var(--accent)' }}
              >
                {t('selectShown')}
              </button>
            </div>
            <ul>
              {visible.map((file) => {
                const Icon = icons[file.kind]
                const days = Math.max(0, Math.floor((Date.now() - file.modified) / 86400000))
                return (
                  <li
                    key={file.id}
                    className="flex items-center gap-3 border-b p-4 last:border-b-0"
                    style={{
                      borderColor: 'var(--border-default)',
                      background: store.selected.has(file.id) ? 'var(--accent-muted-bg)' : undefined
                    }}
                  >
                    <input
                      type="checkbox"
                      aria-label={t('selectFile', { name: file.name })}
                      className="h-4 w-4 shrink-0 accent-[var(--accent)]"
                      checked={store.selected.has(file.id)}
                      disabled={store.busy}
                      onChange={() => store.toggle(file.id)}
                    />
                    <Icon
                      className="hidden h-5 w-5 shrink-0 sm:block"
                      style={{ color: 'var(--accent)' }}
                    />
                    <div className="min-w-0 flex-1">
                      <p
                        className="break-all text-sm font-medium"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {file.name}
                      </p>
                      <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {t(`kinds.${file.kind}`)} · {t('modifiedAgo', { days })} ·{' '}
                        {new Date(file.modified).toLocaleDateString()}
                      </p>
                    </div>
                    <span
                      className="shrink-0 text-sm font-semibold tabular-nums"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {formatBytes(file.size)}
                    </span>
                    <button
                      aria-label={t('reveal', { name: file.name })}
                      title={t('reveal', { name: file.name })}
                      disabled={store.busy}
                      className="rounded-lg p-2"
                      style={{ color: 'var(--text-secondary)' }}
                      onClick={() => {
                        if (store.result)
                          void window.kudu
                            .downloadsReveal(store.result.scanId, file.id)
                            .catch(() => toast.error(t('revealError')))
                      }}
                    >
                      <FolderOpen className="h-4 w-4" />
                    </button>
                  </li>
                )
              })}
            </ul>
            {shown < files.length && (
              <div className="p-4 text-center">
                <button
                  className="rounded-lg border px-4 py-2 text-sm"
                  style={fieldStyle}
                  disabled={store.busy}
                  onClick={() => setShown((value) => value + 50)}
                >
                  {t('showMore')}
                </button>
              </div>
            )}
          </>
        )}
      </section>
      {store.result && (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {t('scope', { count: store.result.skipped })}
        </p>
      )}
      {store.selected.size > 0 && (
        <div
          className="glass-card sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4"
          style={{ borderColor: 'var(--accent)', background: 'var(--card-bg)' }}
        >
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {t('selected', { count: store.selected.size })} · {formatBytes(selectedBytes)}
            </p>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              {t('selectionHint')}
            </p>
          </div>
          <div className="flex gap-3">
            <button
              className="text-sm"
              style={{ color: 'var(--text-secondary)' }}
              disabled={store.busy}
              onClick={store.clearSelection}
            >
              {t('clear')}
            </button>
            <button
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
              style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
              disabled={store.busy}
              onClick={() => setConfirm(true)}
            >
              <Trash2 className="h-4 w-4" />
              {t('move')}
            </button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title={t('confirmTitle', { count: store.selected.size })}
        description={t('confirmDescription')}
        details={selectedFiles.map((file) => file.name).join('\n')}
        confirmLabel={t('move')}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false)
          void store.trash()
        }}
      />
    </div>
  )
}
