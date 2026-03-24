import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  FolderOpen,
  Search,
  X,
  Trash2,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Settings2,
  Plus,
  Shield
} from 'lucide-react'
import { cn, formatBytes } from '@/lib/utils'
import { useDuplicateStore } from '@/stores/duplicate-store'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'

const SIZE_PRESETS = [
  { label: '100 KB', value: 102_400 },
  { label: '1 MB', value: 1_048_576 },
  { label: '10 MB', value: 10_485_760 },
  { label: '100 MB', value: 104_857_600 }
]

const EXT_PRESETS: Record<string, string[]> = {
  images: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff'],
  videos: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm'],
  audio: ['.mp3', '.flac', '.wav', '.aac', '.ogg', '.wma', '.m4a'],
  documents: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv']
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m ${rem}s`
}

const PHASE_LABELS: Record<string, string> = {
  walking: 'phaseWalking',
  grouping: 'phaseGrouping',
  'partial-hash': 'phasePartialHash',
  'full-hash': 'phaseFullHash',
  complete: 'phaseComplete'
}

export function DuplicateFinderPage() {
  const { t } = useTranslation('duplicates')
  const store = useDuplicateStore()
  const [showSettings, setShowSettings] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [excludeInput, setExcludeInput] = useState('')

  // Subscribe to progress events
  useEffect(() => {
    if (!window.kudu?.onDuplicatesProgress) return
    return window.kudu.onDuplicatesProgress((data) => {
      useDuplicateStore.getState().setProgress(data)
    })
  }, [])

  const selectedCount = store.selectedPaths.size
  const selectedSize = useMemo(() => {
    if (!store.result) return 0
    let size = 0
    for (const group of store.result.groups) {
      for (const file of group.files) {
        if (store.selectedPaths.has(file.path)) size += file.size
      }
    }
    return size
  }, [store.result, store.selectedPaths])

  // ── Handlers ──

  const handleSelectDir = async () => {
    const dir = await window.kudu?.duplicatesSelectDir?.()
    if (dir) store.setDirectory(dir)
  }

  const handleScan = async () => {
    if (!store.directory) return
    store.reset()
    store.setStatus('scanning')
    try {
      const result = await window.kudu?.duplicatesScan?.({
        directory: store.directory,
        minFileSize: store.minFileSize,
        maxFileSize: store.maxFileSize,
        excludePatterns: store.excludePatterns,
        extensionFilter: store.extensionFilter,
        maxDepth: store.maxDepth
      })
      if (result) {
        store.setResult(result)
        store.setStatus('complete')
        if (result.groups.length > 0) {
          store.selectAllDuplicates()
        }
      }
    } catch {
      store.setStatus('idle')
    }
  }

  const handleCancel = async () => {
    await window.kudu?.duplicatesCancel?.()
  }

  const handleDelete = async () => {
    setShowConfirm(false)
    const deletingPaths = new Set(store.selectedPaths)
    store.setStatus('deleting')
    try {
      const paths = Array.from(deletingPaths)
      const result = await window.kudu?.duplicatesDelete?.(paths, store.deleteMode)
      if (result) {
        store.setDeleteResult(result)
        if (result.deleted > 0) {
          // Build the set of successfully deleted paths (remove failures)
          const failedPaths = new Set(result.errors.map((e) => e.path))
          const successPaths = new Set<string>()
          for (const p of deletingPaths) {
            if (!failedPaths.has(p)) successPaths.add(p)
          }
          store.removeDeletedFiles(successPaths)
          toast.success(t('deleteSuccess', { count: result.deleted, size: formatBytes(result.spaceRecovered) }))
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

  const toggleGroup = (hash: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(hash)) next.delete(hash)
      else next.add(hash)
      return next
    })
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

  const activeExtPreset = useMemo(() => {
    if (store.extensionFilter.length === 0) return 'all'
    for (const [name, exts] of Object.entries(EXT_PRESETS)) {
      if (exts.length === store.extensionFilter.length && exts.every((e) => store.extensionFilter.includes(e))) {
        return name
      }
    }
    return null
  }, [store.extensionFilter])

  // ── Render ──

  return (
    <div className="flex h-full flex-col overflow-y-auto px-8 py-7">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-[24px] font-bold tracking-tight text-white">{t('pageTitle')}</h1>
        <p className="mt-1.5 text-[13px] animate-fade-in" style={{ color: 'var(--text-muted)' }}>{t('pageDescription')}</p>
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
            {/* Min file size */}
            <div>
              <label className="mb-2 block text-[11px] font-semibold tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                {t('minFileSize')}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {SIZE_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => store.setMinFileSize(p.value)}
                    className={cn(
                      'rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors',
                      store.minFileSize === p.value ? 'text-amber-400' : 'text-zinc-500 hover:text-zinc-300'
                    )}
                    style={{
                      background: store.minFileSize === p.value ? 'rgba(245,158,11,0.1)' : 'var(--bg-subtle-2)'
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Max file size */}
            <div>
              <label className="mb-2 block text-[11px] font-semibold tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                {t('maxFileSize')}
              </label>
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => store.setMaxFileSize(null)}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors',
                    store.maxFileSize === null ? 'text-amber-400' : 'text-zinc-500 hover:text-zinc-300'
                  )}
                  style={{
                    background: store.maxFileSize === null ? 'rgba(245,158,11,0.1)' : 'var(--bg-subtle-2)'
                  }}
                >
                  {t('noLimit')}
                </button>
                {[104_857_600, 1_073_741_824, 5_368_709_120].map((v) => (
                  <button
                    key={v}
                    onClick={() => store.setMaxFileSize(v)}
                    className={cn(
                      'rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors',
                      store.maxFileSize === v ? 'text-amber-400' : 'text-zinc-500 hover:text-zinc-300'
                    )}
                    style={{
                      background: store.maxFileSize === v ? 'rgba(245,158,11,0.1)' : 'var(--bg-subtle-2)'
                    }}
                  >
                    {formatBytes(v, 0)}
                  </button>
                ))}
              </div>
            </div>

            {/* Extension filter */}
            <div>
              <label className="mb-2 block text-[11px] font-semibold tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                {t('extensionFilter')}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {(['all', 'images', 'videos', 'audio', 'documents'] as const).map((preset) => (
                  <button
                    key={preset}
                    onClick={() => store.setExtensionFilter(preset === 'all' ? [] : EXT_PRESETS[preset])}
                    className={cn(
                      'rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors',
                      activeExtPreset === preset ? 'text-amber-400' : 'text-zinc-500 hover:text-zinc-300'
                    )}
                    style={{
                      background: activeExtPreset === preset ? 'rgba(245,158,11,0.1)' : 'var(--bg-subtle-2)'
                    }}
                  >
                    {t(preset === 'all' ? 'allFiles' : preset)}
                  </button>
                ))}
              </div>
            </div>

            {/* Max depth */}
            <div>
              <label className="mb-2 block text-[11px] font-semibold tracking-wide" style={{ color: 'var(--text-secondary)' }}>
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

            {/* Exclude patterns */}
            <div className="col-span-2">
              <label className="mb-2 block text-[11px] font-semibold tracking-wide" style={{ color: 'var(--text-secondary)' }}>
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
                className="h-full rounded-full transition-all duration-300"
                style={{ background: 'var(--accent)', width: `${store.progress.progress}%` }}
              />
            </div>
            <span className="text-[12px] font-medium" style={{ color: 'var(--accent)' }}>
              {store.progress.progress}%
            </span>
          </div>
          <p className="text-[13px] font-medium text-white">
            {t(PHASE_LABELS[store.progress.phase] || 'phaseWalking')}
          </p>
          {store.progress.currentPath && (
            <p
              className="mt-1 truncate text-[12px]"
              style={{ color: 'var(--text-secondary)' }}
              title={store.progress.currentPath}
            >
              {store.progress.currentPath}
            </p>
          )}
          <div className="mt-3 flex gap-6">
            <StatMini label={t('filesScanned')} value={store.progress.filesScanned.toLocaleString()} />
            {store.progress.duplicatesFound > 0 && (
              <StatMini label={t('duplicatesFound')} value={store.progress.duplicatesFound.toLocaleString()} />
            )}
            {store.progress.filesHashed != null && store.progress.filesToHash != null && (
              <StatMini label="Hashed" value={`${store.progress.filesHashed} / ${store.progress.filesToHash}`} />
            )}
          </div>
        </div>
      )}

      {/* Results */}
      {store.status === 'complete' && store.result && (
        <>
          {/* Cancelled banner */}
          {store.result.cancelled && (
            <div
              className="mb-4 rounded-xl px-4 py-2.5 text-[13px] font-medium"
              style={{ background: 'var(--accent-muted-bg)', color: 'var(--accent)' }}
            >
              {t('scanCancelled')}
            </div>
          )}

          {/* Summary stats */}
          <div className="mb-5 grid grid-cols-4 gap-3">
            <StatCard label={t('duplicatesFound')} value={store.result.totalDuplicates.toLocaleString()} />
            <StatCard label={t('reclaimableSpace')} value={formatBytes(store.result.totalReclaimable)} accent />
            <StatCard label={t('filesScanned')} value={store.result.totalFilesScanned.toLocaleString()} />
            <StatCard label={t('duration')} value={formatDuration(store.result.duration)} />
          </div>

          {store.result.groups.length > 0 ? (
            <>
              {/* Action bar */}
              <div className="mb-4 flex items-center gap-3">
                <button
                  onClick={() => {
                    if (selectedCount > 0) store.deselectAll()
                    else store.selectAllDuplicates()
                  }}
                  className="rounded-xl px-4 py-2 text-[12px] font-medium text-zinc-400 transition-colors hover:text-zinc-200"
                  style={{ background: 'var(--bg-subtle-2)' }}
                >
                  {selectedCount > 0 ? t('deselectAll') : t('selectAllDuplicates')}
                </button>

                {/* Delete mode toggle */}
                <div className="flex overflow-hidden rounded-lg" style={{ background: 'var(--bg-subtle-2)' }}>
                  <button
                    onClick={() => store.setDeleteMode('recycle')}
                    className={cn(
                      'px-3 py-1.5 text-[12px] font-medium transition-colors',
                      store.deleteMode === 'recycle' ? 'text-amber-400' : 'text-zinc-500'
                    )}
                    style={store.deleteMode === 'recycle' ? { background: 'rgba(245,158,11,0.1)' } : undefined}
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
                      color: store.deleteMode === 'permanent' ? '#ef4444' : '#f59e0b'
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t('deleteSelected', { count: selectedCount, size: formatBytes(selectedSize) })}
                  </button>
                )}
              </div>

              {/* Duplicate groups */}
              <div className="space-y-2">
                {store.result.groups.map((group) => {
                  const isExpanded = expandedGroups.has(group.fullHash)
                  const sorted = [...group.files].sort((a, b) => a.path.length - b.path.length)
                  const groupSelected = group.files.filter((f) => store.selectedPaths.has(f.path)).length

                  return (
                    <div
                      key={group.fullHash}
                      className="overflow-hidden rounded-xl"
                      style={{ background: 'var(--card-bg)', border: '1px solid var(--border-subtle)' }}
                    >
                      {/* Group header */}
                      <button
                        onClick={() => toggleGroup(group.fullHash)}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.02]"
                      >
                        {isExpanded
                          ? <ChevronDown className="h-4 w-4 shrink-0 text-zinc-500" />
                          : <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" />}
                        <div className="min-w-0 flex-1">
                          <span className="text-[13px] font-medium text-white">
                            {t('groupHeader', { size: formatBytes(group.fileSize), count: group.files.length })}
                          </span>
                        </div>
                        {groupSelected > 0 && (
                          <span className="text-[11px] font-medium" style={{ color: 'var(--accent)' }}>
                            {groupSelected} selected
                          </span>
                        )}
                        <span className="text-[12px] font-medium" style={{ color: '#22c55e' }}>
                          {formatBytes(group.reclaimableSpace)}
                        </span>
                        <span
                          className="rounded px-1.5 py-0.5 font-mono text-[10px]"
                          style={{ background: 'var(--bg-subtle-2)', color: 'var(--text-secondary)' }}
                        >
                          {group.hash}
                        </span>
                      </button>

                      {/* Expanded file list */}
                      {isExpanded && (
                        <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
                          {sorted.map((file, idx) => {
                            const isKept = idx === 0 && !store.selectedPaths.has(file.path)
                            return (
                              <div
                                key={file.path}
                                className="flex items-center gap-3 px-4 py-2 transition-colors hover:bg-white/[0.02]"
                                style={idx > 0 ? { borderTop: '1px solid var(--bg-subtle)' } : undefined}
                              >
                                <input
                                  type="checkbox"
                                  checked={store.selectedPaths.has(file.path)}
                                  onChange={() => store.togglePath(file.path)}
                                  className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded accent-amber-500"
                                />
                                <span
                                  className="min-w-0 flex-1 truncate text-[12px]"
                                  style={{ color: 'var(--text-secondary)' }}
                                  title={file.path}
                                >
                                  {file.path}
                                </span>
                                {isKept && (
                                  <span
                                    className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold"
                                    style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}
                                  >
                                    <Shield className="h-3 w-3" />
                                    {t('original')}
                                  </span>
                                )}
                                <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                                  {new Date(file.lastModified).toLocaleDateString()}
                                </span>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    window.kudu?.duplicatesOpenLocation?.(file.path)
                                  }}
                                  className="shrink-0 text-zinc-600 hover:text-zinc-400"
                                  title={t('openLocation')}
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
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
            ? t('confirmPermanentDesc', { count: selectedCount, size: formatBytes(selectedSize) })
            : t('confirmRecycleDesc', { count: selectedCount, size: formatBytes(selectedSize) })
        }
        variant={store.deleteMode === 'permanent' ? 'danger' : 'warning'}
        confirmLabel={store.deleteMode === 'permanent' ? t('permanentDelete') : t('recycleBin')}
      />
    </div>
  )
}

// ── Small components ──

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className="rounded-xl px-4 py-3"
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</div>
      <div
        className="mt-1 text-[18px] font-bold"
        style={{ color: accent ? 'var(--accent)' : 'var(--text-primary)' }}
      >
        {value}
      </div>
    </div>
  )
}

function StatMini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{label}: </span>
      <span className="text-[12px] font-medium text-white">{value}</span>
    </div>
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
      <FolderOpen className="mb-4 h-12 w-12" style={{ color: 'var(--text-faint)' }} strokeWidth={1.2} />
      <h3 className="text-[15px] font-semibold text-white">{title}</h3>
      <p className="mt-1.5 max-w-sm text-[13px]" style={{ color: 'var(--text-secondary)' }}>{description}</p>
    </div>
  )
}
