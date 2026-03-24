import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  FolderOpen,
  Search,
  X,
  Trash2,
  RotateCcw,
  ExternalLink,
  Settings2,
  Plus,
  FolderX,
  ShieldCheck
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useEmptyFolderStore } from '@/stores/empty-folder-store'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m ${rem}s`
}

export function EmptyFolderCleanerPage() {
  const { t } = useTranslation('emptyFolders')
  const store = useEmptyFolderStore()
  const [showSettings, setShowSettings] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [excludeInput, setExcludeInput] = useState('')

  useEffect(() => {
    if (!window.kudu?.onEmptyFoldersProgress) return
    return window.kudu.onEmptyFoldersProgress((data) => {
      useEmptyFolderStore.getState().setProgress(data)
    })
  }, [])

  const selectedCount = store.selectedPaths.size

  const handleSelectDir = async () => {
    const dir = await window.kudu?.emptyFoldersSelectDir?.()
    if (dir) store.setDirectory(dir)
  }

  const handleScan = async () => {
    if (!store.directory) return
    store.reset()
    store.setStatus('scanning')
    try {
      const result = await window.kudu?.emptyFoldersScan?.({
        directory: store.directory,
        maxDepth: store.maxDepth,
        excludePatterns: store.excludePatterns
      })
      if (result) {
        store.setResult(result)
        store.setStatus('complete')
        if (result.folders.length > 0) {
          store.selectAll()
        }
      }
    } catch {
      store.setStatus('idle')
    }
  }

  const handleCancel = async () => {
    await window.kudu?.emptyFoldersCancel?.()
  }

  const handleDelete = async () => {
    setShowConfirm(false)
    const deletingPaths = new Set(store.selectedPaths)
    store.setStatus('deleting')
    try {
      const paths = Array.from(deletingPaths)
      const result = await window.kudu?.emptyFoldersDelete?.(paths, store.deleteMode)
      if (result) {
        store.setDeleteResult(result)
        if (result.deleted > 0) {
          const failedPaths = new Set(result.errors.map((e) => e.path))
          const successPaths = new Set<string>()
          for (const p of deletingPaths) {
            if (!failedPaths.has(p)) successPaths.add(p)
          }
          store.removeDeletedFolders(successPaths)
          toast.success(t('deleteSuccess', { count: result.deleted }))
        }
        if (result.failed > 0) {
          toast.error(t('deleteFailed', { failed: result.failed }))
        }
        store.setStatus('complete')
      }
    } catch {
      store.setStatus('complete')
    }
  }

  const handleAddExclude = () => {
    const val = excludeInput.trim()
    if (val && !store.excludePatterns.includes(val)) {
      store.setExcludePatterns([...store.excludePatterns, val])
    }
    setExcludeInput('')
  }

  const handleRemoveExclude = (pattern: string) => {
    store.setExcludePatterns(store.excludePatterns.filter((p) => p !== pattern))
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto px-8 py-7">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-[24px] font-bold tracking-tight text-white">{t('pageTitle')}</h1>
        <p className="mt-1.5 text-[13px] animate-fade-in" style={{ color: 'var(--text-muted)' }}>{t('pageDescription')}</p>
      </div>

      {/* Protected note */}
      <div
        className="mb-4 flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-[12px]"
        style={{ background: 'rgba(34,197,94,0.06)', color: '#6ee7b7', border: '1px solid rgba(34,197,94,0.1)' }}
      >
        <ShieldCheck className="h-4 w-4 shrink-0" strokeWidth={1.8} />
        {t('protectedNote')}
      </div>

      {/* Directory selector + scan button */}
      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={handleSelectDir}
          disabled={store.status === 'scanning'}
          className="flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-[13px] font-medium transition-colors"
          style={{ background: 'var(--bg-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-medium)' }}
        >
          <FolderOpen className="h-4 w-4" style={{ color: 'var(--accent)' }} strokeWidth={1.8} />
          {store.directory ? store.directory : t('selectDirectory')}
        </button>

        {store.directory && store.status !== 'scanning' && (
          <button
            onClick={handleScan}
            className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-colors"
            style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
          >
            <Search className="h-4 w-4" strokeWidth={2} />
            {t('scanButton')}
          </button>
        )}

        {store.status === 'scanning' && (
          <button
            onClick={handleCancel}
            className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-medium transition-colors"
            style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}
          >
            <X className="h-4 w-4" strokeWidth={2} />
            {t('cancelScan')}
          </button>
        )}

        <button
          onClick={() => setShowSettings((s) => !s)}
          className={cn(
            'ml-auto flex items-center gap-2 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-colors',
            showSettings ? 'text-amber-400' : 'text-zinc-500 hover:text-zinc-300'
          )}
        >
          <Settings2 className="h-4 w-4" strokeWidth={1.8} />
          {t('settings')}
        </button>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div
          className="mb-5 rounded-2xl p-5"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--border-subtle)' }}
        >
          <div className="grid grid-cols-2 gap-x-8 gap-y-4">
            <div>
              <label className="mb-2 block text-[11px] font-semibold tracking-wide" style={{ color: 'var(--text-muted)' }}>
                {t('maxDepth')}
              </label>
              <input
                type="number"
                min={1}
                max={50}
                value={store.maxDepth}
                onChange={(e) => store.setMaxDepth(Math.max(1, Math.min(50, parseInt(e.target.value) || 20)))}
                className="w-20 rounded-lg px-3 py-1.5 text-[13px] text-white"
                style={{ background: 'var(--bg-subtle-2)', border: '1px solid var(--border-medium)' }}
              />
            </div>

            <div className="col-span-2">
              <label className="mb-2 block text-[11px] font-semibold tracking-wide" style={{ color: 'var(--text-muted)' }}>
                {t('excludePatterns')}
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                {store.excludePatterns.map((p) => (
                  <span
                    key={p}
                    className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[12px] font-medium"
                    style={{ background: 'var(--bg-subtle-2)', color: 'var(--text-secondary)' }}
                  >
                    {p}
                    <button onClick={() => handleRemoveExclude(p)} className="text-zinc-600 hover:text-zinc-400">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={excludeInput}
                    onChange={(e) => setExcludeInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddExclude()}
                    placeholder={t('excludePlaceholder')}
                    className="w-48 rounded-lg px-2.5 py-1 text-[12px] text-white placeholder-zinc-600"
                    style={{ background: 'var(--bg-subtle-2)', border: '1px solid var(--border-medium)' }}
                  />
                  <button onClick={handleAddExclude} className="text-zinc-500 hover:text-zinc-300">
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Scanning progress */}
      {store.status === 'scanning' && store.progress && (
        <div
          className="mb-5 rounded-2xl p-5"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--border-subtle)' }}
        >
          <div className="mb-3 flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--bg-hover-2)' }}>
              <div
                className="h-full animate-pulse rounded-full"
                style={{ background: 'var(--accent)', width: '100%' }}
              />
            </div>
          </div>
          <p className="text-[13px] font-medium text-white">{t('scanning')}</p>
          {store.progress.currentPath && (
            <p className="mt-1 truncate text-[12px]" style={{ color: 'var(--text-muted)' }} title={store.progress.currentPath}>
              {store.progress.currentPath}
            </p>
          )}
          <div className="mt-3 flex gap-6">
            <StatMini label={t('foldersScanned')} value={store.progress.foldersScanned.toLocaleString()} />
            <StatMini label={t('emptyFound')} value={store.progress.emptyFound.toLocaleString()} />
          </div>
        </div>
      )}

      {/* Results */}
      {store.status === 'complete' && store.result && (
        <>
          {/* Summary stats */}
          <div className="mb-5 grid grid-cols-3 gap-3">
            <StatCard label={t('emptyFound')} value={store.result.folders.length.toLocaleString()} accent />
            <StatCard label={t('foldersScanned')} value={store.result.totalFoldersScanned.toLocaleString()} />
            <StatCard label={t('duration')} value={formatDuration(store.result.duration)} />
          </div>

          {store.result.folders.length > 0 ? (
            <>
              {/* Action bar */}
              <div className="mb-4 flex items-center gap-3">
                <button
                  onClick={() => { if (selectedCount > 0) store.deselectAll(); else store.selectAll() }}
                  className="rounded-xl px-4 py-2 text-[12px] font-medium text-zinc-400 transition-colors hover:text-zinc-200"
                  style={{ background: 'var(--bg-subtle-2)' }}
                >
                  {selectedCount > 0 ? t('deselectAll') : t('selectAll')}
                </button>

                <div className="flex overflow-hidden rounded-lg" style={{ background: 'var(--bg-subtle-2)' }}>
                  <button
                    onClick={() => store.setDeleteMode('recycle')}
                    className={cn(
                      'px-3 py-1.5 text-[12px] font-medium transition-colors',
                      store.deleteMode === 'recycle' ? 'text-amber-400' : 'text-zinc-500'
                    )}
                    style={store.deleteMode === 'recycle' ? { background: 'var(--accent-muted-bg)' } : undefined}
                  >
                    {t('recycleBin')}
                  </button>
                  <button
                    onClick={() => store.setDeleteMode('permanent')}
                    className={cn(
                      'px-3 py-1.5 text-[12px] font-medium transition-colors',
                      store.deleteMode === 'permanent' ? 'text-red-400' : 'text-zinc-500'
                    )}
                    style={store.deleteMode === 'permanent' ? { background: 'rgba(239,68,68,0.1)' } : undefined}
                  >
                    {t('permanentDelete')}
                  </button>
                </div>

                <div className="flex-1" />

                <button
                  onClick={() => store.reset()}
                  className="flex items-center gap-2 rounded-xl px-4 py-2 text-[12px] font-medium text-zinc-400 transition-colors hover:text-zinc-200"
                  style={{ background: 'var(--bg-subtle-2)' }}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('scanAgain')}
                </button>

                {selectedCount > 0 && (
                  <button
                    onClick={() => setShowConfirm(true)}
                    className="flex items-center gap-2 rounded-xl px-5 py-2 text-[13px] font-semibold transition-colors"
                    style={{
                      background: store.deleteMode === 'permanent' ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.12)',
                      color: store.deleteMode === 'permanent' ? '#ef4444' : 'var(--accent)'
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t('deleteSelected', { count: selectedCount })}
                  </button>
                )}
              </div>

              {/* Folder list */}
              <div
                className="min-h-0 flex-1 overflow-y-auto rounded-xl"
                style={{ background: 'var(--card-bg)', border: '1px solid var(--border-subtle)' }}
              >
                {store.result.folders.map((folder, idx) => (
                  <div
                    key={folder.path}
                    className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-white/[0.02]"
                    style={idx > 0 ? { borderTop: '1px solid var(--bg-subtle)' } : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={store.selectedPaths.has(folder.path)}
                      onChange={() => store.togglePath(folder.path)}
                      className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded accent-amber-500"
                    />
                    <FolderX className="h-4 w-4 shrink-0" style={{ color: 'var(--text-muted)' }} strokeWidth={1.5} />
                    <span
                      className="min-w-0 flex-1 truncate text-[12.5px]"
                      style={{ color: 'var(--text-secondary)' }}
                      title={folder.path}
                    >
                      {folder.path}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        window.kudu?.emptyFoldersOpenLocation?.(folder.path)
                      }}
                      className="shrink-0 text-zinc-600 hover:text-zinc-400"
                      title={t('openLocation')}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
          )}
        </>
      )}

      {/* Idle state */}
      {store.status === 'idle' && !store.result && (
        <EmptyState title={t('idleTitle')} description={t('idleDescription')} />
      )}

      {/* Deleting overlay */}
      {store.status === 'deleting' && (
        <div
          className="mb-5 flex items-center gap-3 rounded-2xl p-5"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--border-subtle)' }}
        >
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
          <span className="text-[13px] font-medium text-white">{t('deleting')}</span>
        </div>
      )}

      {/* Confirm dialog */}
      <ConfirmDialog
        open={showConfirm}
        onConfirm={handleDelete}
        onCancel={() => setShowConfirm(false)}
        title={t('confirmDeleteTitle')}
        description={
          store.deleteMode === 'permanent'
            ? t('confirmPermanentDesc', { count: selectedCount })
            : t('confirmRecycleDesc', { count: selectedCount })
        }
        variant={store.deleteMode === 'permanent' ? 'danger' : 'warning'}
        confirmLabel={store.deleteMode === 'permanent' ? t('permanentDelete') : t('recycleBin')}
      />
    </div>
  )
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className="rounded-xl px-4 py-3"
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="mt-1 text-[18px] font-bold" style={{ color: accent ? 'var(--accent)' : 'var(--text-primary)' }}>{value}</div>
    </div>
  )
}

function StatMini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}: </span>
      <span className="text-[12px] font-medium text-white">{value}</span>
    </div>
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
      <FolderX className="mb-4 h-12 w-12" style={{ color: 'var(--text-faint)' }} strokeWidth={1.2} />
      <h3 className="text-[15px] font-semibold text-white">{title}</h3>
      <p className="mt-1.5 max-w-sm text-[13px]" style={{ color: 'var(--text-muted)' }}>{description}</p>
    </div>
  )
}
