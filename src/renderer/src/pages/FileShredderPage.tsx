import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  FilePlus2,
  FolderPlus,
  X,
  ExternalLink,
  ShieldAlert,
  File,
  Folder,
  RotateCcw
} from 'lucide-react'
import { formatBytes } from '@/lib/utils'
import { useFileShredderStore } from '@/stores/file-shredder-store'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m ${rem}s`
}

export function FileShredderPage() {
  const { t } = useTranslation('fileShredder')
  const store = useFileShredderStore()
  const [showConfirm, setShowConfirm] = useState(false)

  useEffect(() => {
    if (!window.kudu?.onShredderProgress) return
    return window.kudu.onShredderProgress((data) => {
      useFileShredderStore.getState().setProgress(data)
    })
  }, [])

  const totalSize = useMemo(
    () => store.entries.reduce((sum, e) => sum + e.size, 0),
    [store.entries]
  )

  const handleAddFiles = async () => {
    const entries = await window.kudu?.shredderSelectFiles?.()
    if (entries?.length) store.addEntries(entries)
  }

  const handleAddFolders = async () => {
    const entries = await window.kudu?.shredderSelectFolders?.()
    if (entries?.length) store.addEntries(entries)
  }

  const handleShred = async () => {
    setShowConfirm(false)
    store.setStatus('shredding')
    try {
      const paths = store.entries.map((e) => e.path)
      const result = await window.kudu?.shredderShred?.(paths)
      if (result) {
        store.setResult(result)
        if (result.cancelled) {
          // Return to idle so the user can see remaining entries and retry
          store.setStatus('idle')
          if (result.shredded > 0) {
            toast.success(t('shredCancelled', { count: result.shredded, size: formatBytes(result.bytesShredded) }))
          }
        } else {
          store.setStatus('complete')
          if (result.shredded > 0) {
            toast.success(t('shredSuccess', { count: result.shredded, size: formatBytes(result.bytesShredded) }))
          }
        }
        if (result.failed > 0) {
          toast.error(t('shredFailed', { failed: result.failed }))
        }
      }
    } catch {
      store.setStatus('idle')
    }
  }

  const handleCancel = async () => {
    await window.kudu?.shredderCancel?.()
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto px-8 py-7">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-[24px] font-bold tracking-tight text-white">{t('pageTitle')}</h1>
        <p className="mt-1.5 text-[13px] animate-fade-in" style={{ color: '#5e5e68' }}>{t('pageDescription')}</p>
      </div>

      {/* Action buttons */}
      {store.status !== 'complete' && (
        <div className="mb-4 flex items-center gap-3">
          <button
            onClick={handleAddFiles}
            disabled={store.status === 'shredding'}
            className="flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-[13px] font-medium transition-colors disabled:opacity-50"
            style={{ background: 'rgba(255,255,255,0.05)', color: '#d4d4d8', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <FilePlus2 className="h-4 w-4" style={{ color: '#f59e0b' }} strokeWidth={1.8} />
            {t('addFiles')}
          </button>

          <button
            onClick={handleAddFolders}
            disabled={store.status === 'shredding'}
            className="flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-[13px] font-medium transition-colors disabled:opacity-50"
            style={{ background: 'rgba(255,255,255,0.05)', color: '#d4d4d8', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <FolderPlus className="h-4 w-4" style={{ color: '#f59e0b' }} strokeWidth={1.8} />
            {t('addFolders')}
          </button>

          {store.entries.length > 0 && store.status === 'idle' && (
            <>
              <button
                onClick={() => store.clearEntries()}
                className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-[12px] font-medium text-zinc-500 transition-colors hover:text-zinc-300"
              >
                <X className="h-3.5 w-3.5" />
                {t('clearAll')}
              </button>

              <div className="flex-1" />

              <button
                onClick={() => setShowConfirm(true)}
                className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-colors"
                style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444' }}
              >
                <ShieldAlert className="h-4 w-4" strokeWidth={2} />
                {store.entries.length === 1 ? t('shredButtonSingle') : t('shredButton', { count: store.entries.length })}
              </button>
            </>
          )}

          {store.status === 'shredding' && (
            <>
              <div className="flex-1" />
              <button
                onClick={handleCancel}
                className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-medium transition-colors"
                style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}
              >
                <X className="h-4 w-4" strokeWidth={2} />
                {t('cancelShred')}
              </button>
            </>
          )}
        </div>
      )}

      {/* Shredding progress */}
      {store.status === 'shredding' && store.progress && (
        <div
          className="mb-5 rounded-2xl p-5"
          style={{ background: '#1c1c21', border: '1px solid rgba(255,255,255,0.04)' }}
        >
          <div className="mb-3 flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ background: '#ef4444', width: `${Math.min(100, store.progress.progress)}%` }}
              />
            </div>
            <span className="text-[12px] font-medium" style={{ color: '#a1a1aa' }}>
              {Math.round(store.progress.progress)}%
            </span>
          </div>
          <p className="text-[13px] font-medium text-white">{t('shredding')}</p>
          {store.progress.currentPath && (
            <p className="mt-1 truncate text-[12px]" style={{ color: '#6e6e76' }} title={store.progress.currentPath}>
              {store.progress.currentPath}
            </p>
          )}
          <div className="mt-3 flex gap-6">
            <StatMini label={t('filesShredded')} value={`${store.progress.filesShredded} / ${store.progress.totalFiles}`} />
            <StatMini label={t('bytesShredded')} value={formatBytes(store.progress.bytesShredded)} />
          </div>
        </div>
      )}

      {/* Complete state */}
      {store.status === 'complete' && store.result && (
        <>
          <div className="mb-5 grid grid-cols-4 gap-3">
            <StatCard label={t('filesShredded')} value={store.result.shredded.toLocaleString()} />
            <StatCard label={t('bytesShredded')} value={formatBytes(store.result.bytesShredded)} accent />
            <StatCard label={t('duration')} value={formatDuration(store.result.duration)} />
            <StatCard label={t('failed')} value={store.result.failed.toLocaleString()} />
          </div>

          <div className="flex items-center justify-center py-10">
            <button
              onClick={() => store.reset()}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-colors"
              style={{ background: '#f59e0b', color: '#1a0a00' }}
            >
              <RotateCcw className="h-4 w-4" strokeWidth={2} />
              {t('shredAnother')}
            </button>
          </div>
        </>
      )}

      {/* Entry list */}
      {store.status === 'idle' && store.entries.length > 0 && (
        <>
          <div className="mb-3 flex items-center gap-3">
            <span className="text-[12px] font-medium" style={{ color: '#6e6e76' }}>
              {t('itemCount', { count: store.entries.length })}
            </span>
            <span className="text-[12px] font-medium" style={{ color: '#f59e0b' }}>
              {formatBytes(totalSize)}
            </span>
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto rounded-xl"
            style={{ background: '#1c1c21', border: '1px solid rgba(255,255,255,0.04)' }}
          >
            {store.entries.map((entry, idx) => (
              <div
                key={entry.path}
                className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-white/[0.02]"
                style={idx > 0 ? { borderTop: '1px solid rgba(255,255,255,0.03)' } : undefined}
              >
                {entry.isDirectory ? (
                  <Folder className="h-4 w-4 shrink-0" style={{ color: '#f59e0b' }} strokeWidth={1.5} />
                ) : (
                  <File className="h-4 w-4 shrink-0" style={{ color: '#52525b' }} strokeWidth={1.5} />
                )}
                <span
                  className="min-w-0 flex-1 truncate text-[12.5px]"
                  style={{ color: '#a1a1aa' }}
                  title={entry.path}
                >
                  {entry.path}
                </span>
                <span className="shrink-0 text-[11px] font-medium" style={{ color: '#6e6e76' }}>
                  {entry.isDirectory ? t('folder') : t('file')}
                </span>
                <span className="shrink-0 text-[12px] font-semibold" style={{ color: '#f59e0b' }}>
                  {formatBytes(entry.size)}
                </span>
                <button
                  onClick={() => window.kudu?.shredderOpenLocation?.(entry.path)}
                  className="shrink-0 text-zinc-600 hover:text-zinc-400"
                  title={t('openLocation')}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => store.removeEntry(entry.path)}
                  className="shrink-0 text-zinc-600 hover:text-red-400"
                  title={t('remove')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Empty state */}
      {store.status === 'idle' && store.entries.length === 0 && (
        <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
      )}

      {/* Confirm dialog */}
      <ConfirmDialog
        open={showConfirm}
        onConfirm={handleShred}
        onCancel={() => setShowConfirm(false)}
        title={t('confirmTitle')}
        description={t('confirmDesc', { count: store.entries.length, size: formatBytes(totalSize) })}
        variant="danger"
        confirmLabel={store.entries.length === 1 ? t('shredButtonSingle') : t('shredButton', { count: store.entries.length })}
      />
    </div>
  )
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className="rounded-xl px-4 py-3"
      style={{ background: '#1c1c21', border: '1px solid rgba(255,255,255,0.04)' }}
    >
      <div className="text-[11px] font-medium" style={{ color: '#6e6e76' }}>{label}</div>
      <div className="mt-1 text-[18px] font-bold" style={{ color: accent ? '#ef4444' : '#fafafa' }}>{value}</div>
    </div>
  )
}

function StatMini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-[11px]" style={{ color: '#6e6e76' }}>{label}: </span>
      <span className="text-[12px] font-medium text-white">{value}</span>
    </div>
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
      <ShieldAlert className="mb-4 h-12 w-12" style={{ color: '#3f3f46' }} strokeWidth={1.2} />
      <h3 className="text-[15px] font-semibold text-white">{title}</h3>
      <p className="mt-1.5 max-w-sm text-[13px]" style={{ color: '#6e6e76' }}>{description}</p>
    </div>
  )
}
