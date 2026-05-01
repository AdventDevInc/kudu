import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  MousePointerClick, Search, StopCircle, Loader2, ChevronDown, Lock, Shield,
  CheckCircle2, X, Power, Trash2, RotateCcw, Filter, AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { ErrorAlert } from '@/components/shared/ErrorAlert'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { ScanProgress } from '@/components/shared/ScanProgress'
import { usePlatform } from '@/hooks/usePlatform'
import { useContextMenuStore } from '@/stores/context-menu-store'
import type {
  ContextMenuAction,
  ContextMenuApplyRequest,
  ContextMenuEntry,
  ContextMenuScope,
  ContextMenuSource,
  ContextMenuStatus,
} from '@shared/types'

const WIN11_NOTICE_KEY = 'kudu.contextMenu.win11Notice.dismissed'

const SOURCE_PILL_COLOR: Record<ContextMenuSource, { bg: string; text: string }> = {
  '7-Zip':        { bg: 'rgba(59,130,246,0.10)',  text: '#60a5fa' },
  'WinRAR':       { bg: 'rgba(168,85,247,0.10)',  text: '#c084fc' },
  'OneDrive':     { bg: 'rgba(14,165,233,0.10)',  text: '#38bdf8' },
  'Notepad++':    { bg: 'rgba(34,197,94,0.10)',   text: '#4ade80' },
  'VSCode':       { bg: 'rgba(99,102,241,0.10)',  text: '#818cf8' },
  'Defender':     { bg: 'rgba(34,197,94,0.10)',   text: '#22c55e' },
  'Git':          { bg: 'rgba(244,114,22,0.10)',  text: '#fb923c' },
  'Dropbox':      { bg: 'rgba(59,130,246,0.10)',  text: '#60a5fa' },
  'Google Drive': { bg: 'rgba(245,158,11,0.10)',  text: '#fbbf24' },
  'PowerToys':    { bg: 'rgba(168,85,247,0.10)',  text: '#c084fc' },
  'Microsoft':    { bg: 'rgba(20,184,166,0.10)',  text: '#2dd4bf' },
  'Windows':      { bg: 'rgba(20,184,166,0.10)',  text: '#2dd4bf' },
  'Unknown':      { bg: 'var(--bg-hover)',        text: 'var(--text-muted)' },
}

const SCOPE_LABEL_KEY: Record<ContextMenuScope, string> = {
  AllFiles:             'scopeAllFiles',
  Directory:            'scopeDirectory',
  DirectoryBackground:  'scopeDirectoryBackground',
  Folder:               'scopeFolder',
  Drive:                'scopeDrive',
  AllFilesystemObjects: 'scopeAllFilesystemObjects',
  ProgID:               'scopeProgID',
}

export function ContextMenuCleanerPage() {
  const { features } = usePlatform()
  const { t } = useTranslation('contextMenu')

  if (!features.contextMenu) {
    return (
      <div className="animate-fade-in">
        <PageHeader title={t('pageHeaderUnavailableTitle')} description={t('pageHeaderUnavailableDescription')} />
        <EmptyState icon={MousePointerClick} title={t('notAvailableTitle')} description={t('notAvailableDescription')} />
      </div>
    )
  }
  return <ContextMenuCleanerPageContent />
}

function ContextMenuCleanerPageContent() {
  const { t } = useTranslation('contextMenu')

  const entries     = useContextMenuStore((s) => s.entries)
  const scanning    = useContextMenuStore((s) => s.scanning)
  const scanned     = useContextMenuStore((s) => s.scanned)
  const applying    = useContextMenuStore((s) => s.applying)
  const applyProg   = useContextMenuStore((s) => s.applyProgress)
  const applyResult = useContextMenuStore((s) => s.applyResult)
  const showErrors  = useContextMenuStore((s) => s.showErrors)
  const error       = useContextMenuStore((s) => s.error)
  const filters     = useContextMenuStore((s) => s.filters)
  const expanded    = useContextMenuStore((s) => s.expandedGroups)

  const [showWin11, setShowWin11] = useState(() => {
    try { return !localStorage.getItem(WIN11_NOTICE_KEY) } catch { return true }
  })
  const [pendingDelete, setPendingDelete] = useState<ContextMenuApplyRequest[] | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  // Subscribe to apply-progress events from main.
  useEffect(() => {
    const cleanup = window.kudu.onContextMenuApplyProgress((data) => {
      useContextMenuStore.getState().setApplyProgress(data)
    })
    cleanupRef.current = cleanup
    return () => cleanup()
  }, [])

  const handleScan = useCallback(async () => {
    const store = useContextMenuStore.getState()
    store.setScanning(true)
    store.setScanned(false)
    store.setEntries([])
    store.setApplyResult(null)
    store.setError(null)
    try {
      const result = await window.kudu.contextMenuScan()
      const sorted = [...(result.entries ?? [])].sort((a, b) => {
        if (a.source === b.source) return a.displayName.localeCompare(b.displayName)
        if (a.source === 'Unknown') return 1
        if (b.source === 'Unknown') return -1
        return a.source.localeCompare(b.source)
      })
      useContextMenuStore.getState().setEntries(sorted)
      useContextMenuStore.getState().setScanned(true)
    } catch (err) {
      console.error('Context-menu scan failed:', err)
      toast.error(t('toastScanFailed'), { description: t('toastScanFailedDescription') })
      useContextMenuStore.getState().setError(t('toastScanFailedDescription'))
    }
    useContextMenuStore.getState().setScanning(false)
  }, [t])

  const handleScanCancel = useCallback(async () => {
    try { await window.kudu.contextMenuScanCancel() } catch { /* ignore */ }
    useContextMenuStore.getState().setScanning(false)
  }, [])

  const dismissWin11 = useCallback(() => {
    try { localStorage.setItem(WIN11_NOTICE_KEY, '1') } catch { /* skip */ }
    setShowWin11(false)
  }, [])

  // Filtered list
  const visible = useMemo(() => filterEntries(entries, filters), [entries, filters])

  // Group by source then scope.
  const groups = useMemo(() => groupBySource(visible), [visible])

  // Available filter options derived from entries.
  const availableSources = useMemo(() => {
    const set = new Set<ContextMenuSource>()
    for (const e of entries) set.add(e.source)
    return Array.from(set).sort()
  }, [entries])
  const availableScopes = useMemo(() => {
    const set = new Set<ContextMenuScope>()
    for (const e of entries) set.add(e.scope)
    return Array.from(set).sort()
  }, [entries])

  const selectedRequests = useMemo(
    () => entries.filter((e) => e.selected && !e.protected),
    [entries]
  )
  const selectedCount = selectedRequests.length

  const buildRequests = (action: ContextMenuAction): ContextMenuApplyRequest[] =>
    selectedRequests.map((e) => ({ entryId: e.id, action }))

  const handleApply = useCallback(async (action: ContextMenuAction, requests?: ContextMenuApplyRequest[]) => {
    // Read selection from the store at call time — closing over `selectedRequests`
    // (or `buildRequests`) here would freeze the empty initial selection inside the
    // memoised callback and turn bulk-action clicks into no-ops.
    const reqs = requests ?? useContextMenuStore.getState().entries
      .filter((e) => e.selected && !e.protected)
      .map((e) => ({ entryId: e.id, action }))
    if (reqs.length === 0) return
    const store = useContextMenuStore.getState()
    store.setApplying(true)
    store.setApplyResult(null)
    store.setApplyProgress({ current: 0, total: reqs.length, currentLabel: t('applyingTitle') })
    try {
      const result = await window.kudu.contextMenuApply(reqs)
      const s = useContextMenuStore.getState()
      s.setApplyResult(result)
      if (result.updates.length > 0) s.applyUpdates(result.updates)
      if (action === 'delete') {
        const ok = new Set(result.updates.map((u) => u.entryId))
        const succeededIds = reqs.filter((r) => ok.has(r.entryId)).map((r) => r.entryId)
        if (succeededIds.length > 0) s.removeEntries(succeededIds)
      }
    } catch (err) {
      console.error('Context-menu apply failed:', err)
      toast.error(t('toastApplyFailed'), { description: t('toastApplyFailedDescription') })
      useContextMenuStore.getState().setError(t('toastApplyFailedDescription'))
    }
    useContextMenuStore.getState().setApplying(false)
    useContextMenuStore.getState().setApplyProgress(null)
  }, [t])

  const onConfirmDelete = useCallback(() => {
    const reqs = pendingDelete
    setPendingDelete(null)
    if (reqs) handleApply('delete', reqs)
  }, [pendingDelete, handleApply])

  const requiresAdminInSelection = selectedRequests.some((e) => e.requiresAdmin)

  return (
    <div className="animate-fade-in">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        action={
          <div className="flex items-center gap-2.5">
            <button onClick={handleScan} disabled={scanning || applying}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-medium text-zinc-300 transition-all disabled:opacity-40"
              style={{ background: 'var(--bg-hover)', border: '1px solid var(--border-medium)' }}>
              {scanned ? <RotateCcw className="h-4 w-4" strokeWidth={1.8} /> : <Search className="h-4 w-4" strokeWidth={1.8} />}
              {scanned ? t('rescanButton') : t('scanButton')}
            </button>
          </div>
        }
      />

      {showWin11 && (
        <div className="mb-5 flex items-start gap-3 rounded-2xl px-5 py-4"
          style={{ background: 'var(--accent-muted-bg)', border: '1px solid var(--accent-muted-bg)' }}>
          <Shield className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" strokeWidth={1.8} />
          <div className="flex-1 text-[12px]">
            <p className="font-semibold text-amber-500">{t('win11NoticeTitle')}</p>
            <p className="mt-0.5" style={{ color: 'var(--text-muted)' }}>{t('win11NoticeBody')}</p>
          </div>
          <button onClick={dismissWin11}
            className="rounded-md p-1 transition-colors hover:bg-zinc-800"
            aria-label={t('win11NoticeDismiss')}>
            <X className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} strokeWidth={2} />
          </button>
        </div>
      )}

      {error && (
        <ErrorAlert message={error} onDismiss={() => useContextMenuStore.getState().setError(null)} className="mb-5" />
      )}

      {scanning && (
        <div className="mb-5 flex items-center gap-3">
          <div className="flex-1">
            <ScanProgress status="scanning" progress={0} currentPath={t('scanningLabel')} />
          </div>
          <button onClick={handleScanCancel}
            className="flex shrink-0 items-center gap-1.5 rounded-xl px-4 py-2 text-[12px] font-medium text-red-400 transition-all hover:text-red-300"
            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)' }}>
            <StopCircle className="h-3.5 w-3.5" strokeWidth={2} /> {t('cancelButton')}
          </button>
        </div>
      )}

      {applying && applyProg && (
        <div className="mb-5 rounded-2xl p-5"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}>
          <div className="mb-3 flex items-center gap-2.5">
            <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
            <span className="text-[13px] font-medium text-zinc-200">{t('applyingTitle')}</span>
            <span className="ml-auto font-mono text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {applyProg.current} / {applyProg.total}
            </span>
          </div>
          <div className="mb-2 h-[6px] overflow-hidden rounded-full" style={{ background: 'var(--bg-subtle-2)' }}>
            <div className="h-full rounded-full transition-all duration-200 ease-out"
              style={{
                width: `${applyProg.total > 0 ? (applyProg.current / applyProg.total) * 100 : 0}%`,
                background: 'linear-gradient(90deg, #f59e0b 0%, #d97706 100%)',
              }} />
          </div>
          <p className="truncate font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {applyProg.currentLabel}
          </p>
        </div>
      )}

      {applyResult && (
        <div className="mb-5 overflow-hidden rounded-2xl"
          style={{ border: `1px solid ${applyResult.failed > 0 ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)'}` }}>
          <div className="flex items-center gap-3 p-4"
            style={{ background: applyResult.failed > 0 ? 'rgba(239,68,68,0.04)' : 'rgba(34,197,94,0.06)' }}>
            <CheckCircle2 className="h-5 w-5 text-green-500" strokeWidth={1.8} />
            <p className="flex-1 text-[13px] text-zinc-200">
              {applyResult.succeeded === 1
                ? t('applyDoneSuccess', { count: applyResult.succeeded })
                : t('applyDoneSuccessPlural', { count: applyResult.succeeded })}
              {applyResult.failed > 0 && (
                <button onClick={() => useContextMenuStore.getState().setShowErrors(!showErrors)}
                  className="ml-2 text-red-400 underline decoration-red-400/30 hover:decoration-red-400 transition-colors">
                  {t('applyDoneFailureCount', { count: applyResult.failed })} —{' '}
                  {showErrors ? t('applyHideFailures') : t('applyShowFailures')}
                </button>
              )}
            </p>
          </div>
          {showErrors && applyResult.errors.length > 0 && (
            <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
              {applyResult.errors.map((err, i) => (
                <div key={`${err.entryId}-${i}`} className="flex items-start gap-3 px-5 py-3"
                  style={{ borderBottom: i < applyResult.errors.length - 1 ? '1px solid var(--bg-subtle)' : 'none' }}>
                  <div className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />
                  <div className="min-w-0">
                    <p className="text-[12px] text-zinc-300">{err.displayName}</p>
                    <p className="mt-0.5 text-[11px] text-red-400/80">{err.reason}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!scanned && !scanning && (
        <EmptyState
          icon={MousePointerClick}
          title={t('emptyStateTitle')}
          description={t('emptyStateDescription')}
          action={
            <button onClick={handleScan} disabled={applying}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all disabled:opacity-40"
              style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', color: 'var(--text-on-accent)' }}>
              <Search className="h-4 w-4" strokeWidth={1.8} /> {t('scanButton')}
            </button>
          }
        />
      )}

      {scanned && entries.length > 0 && (
        <FilterBar
          filters={filters}
          availableScopes={availableScopes}
          availableSources={availableSources}
          onChange={(key, value) => useContextMenuStore.getState().setFilter(key, value)}
        />
      )}

      {scanned && visible.length === 0 && (
        <EmptyState icon={Filter} title={t('noResultsTitle')} description={t('noResultsDescription')} />
      )}

      {scanned && groups.length > 0 && (
        <div className="grid grid-cols-1 gap-3" style={{ paddingBottom: selectedCount > 0 ? 90 : 0 }}>
          {groups.map((group) => {
            const groupKey = `src:${group.source}`
            const isExpanded = expanded.has(groupKey)
            const eligibleIds = group.entries.filter((e) => !e.protected).map((e) => e.id)
            const allSelected = eligibleIds.length > 0
              && eligibleIds.every((id) => entries.find((e) => e.id === id)?.selected)
            const pill = SOURCE_PILL_COLOR[group.source]
            return (
              <div key={groupKey} className="overflow-hidden rounded-2xl"
                style={{ border: '1px solid var(--border-default)', opacity: applying ? 0.5 : 1, pointerEvents: applying ? 'none' : 'auto' }}>
                <div className="flex items-center gap-4 px-5 py-4"
                  style={{ background: 'var(--bg-subtle)' }}>
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                    style={{ background: pill.bg }}>
                    <MousePointerClick className="h-5 w-5" style={{ color: pill.text }} strokeWidth={1.8} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2.5">
                      <span className="text-[14px] font-semibold text-zinc-200">{group.source}</span>
                      <span className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                        style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
                        {group.entries.length}
                      </span>
                    </div>
                  </div>
                  {eligibleIds.length > 0 && (
                    <button
                      onClick={() => useContextMenuStore.getState().toggleAllVisible(eligibleIds, !allSelected)}
                      className="relative h-6 w-11 rounded-full transition-colors"
                      style={{ background: allSelected ? pill.text : 'var(--bg-active)' }}
                      aria-label="toggle all"
                    >
                      <div className="absolute top-0.5 h-5 w-5 rounded-full transition-all"
                        style={{
                          left: allSelected ? '22px' : '2px',
                          background: allSelected ? '#fff' : 'var(--text-secondary)'
                        }} />
                    </button>
                  )}
                  <button onClick={() => useContextMenuStore.getState().toggleGroup(groupKey)}
                    className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
                    style={{ background: 'var(--bg-subtle-2)' }}>
                    <ChevronDown className="h-4 w-4 transition-transform"
                      style={{ color: 'var(--text-secondary)', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
                      strokeWidth={2} />
                  </button>
                </div>

                {isExpanded && (
                  <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    {group.entries.map((entry, i) => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        isLast={i === group.entries.length - 1}
                        onToggle={() => useContextMenuStore.getState().toggleEntry(entry.id)}
                        onAction={(action) => {
                          if (action === 'delete') {
                            setPendingDelete([{ entryId: entry.id, action }])
                          } else {
                            handleApply(action, [{ entryId: entry.id, action }])
                          }
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {selectedCount > 0 && !applying && (
        <div className="fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-2xl px-3 py-2"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--border-medium)', boxShadow: '0 12px 40px rgba(0,0,0,0.35)' }}>
          <span className="px-3 text-[12px] font-medium text-zinc-300">
            {t('selectedCount', { count: selectedCount })}
          </span>
          <button onClick={() => handleApply('disable')}
            className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-medium text-zinc-200 transition-colors"
            style={{ background: 'var(--bg-hover)' }}>
            <Power className="h-3.5 w-3.5" strokeWidth={2} /> {t('disableSelected')}
          </button>
          <button onClick={() => handleApply('enable')}
            className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-medium text-emerald-400 transition-colors"
            style={{ background: 'rgba(34,197,94,0.08)' }}>
            <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} /> {t('enableSelected')}
          </button>
          <button onClick={() => setPendingDelete(buildRequests('delete'))}
            className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-medium text-red-400 transition-colors"
            style={{ background: 'rgba(239,68,68,0.08)' }}>
            <Trash2 className="h-3.5 w-3.5" strokeWidth={2} /> {t('deleteSelected')}
          </button>
        </div>
      )}

      {requiresAdminInSelection && selectedCount > 0 && !applying && (
        <div className="mb-3 flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-[12px]"
          style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.18)' }}>
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" strokeWidth={1.8} />
          <span className="flex-1 text-zinc-300">{t('elevationPrompt')}</span>
          <button
            onClick={() => window.kudu.elevationRelaunch?.().catch(() => {})}
            className="rounded-md px-3 py-1 text-[11px] font-medium text-amber-400"
            style={{ background: 'rgba(245,158,11,0.10)' }}>
            {t('elevationRelaunch')}
          </button>
        </div>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        onConfirm={onConfirmDelete}
        onCancel={() => setPendingDelete(null)}
        title={t('confirmDeleteTitle')}
        description={
          (pendingDelete?.length ?? 0) === 1
            ? t('confirmDeleteDescription', { count: pendingDelete?.length ?? 0 })
            : t('confirmDeleteDescriptionPlural', { count: pendingDelete?.length ?? 0 })
        }
        confirmLabel={t('confirmDeleteLabel')}
        variant="danger"
      />
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────

function filterEntries(entries: ContextMenuEntry[], filters: { search: string; scope: ContextMenuScope | 'all'; source: ContextMenuSource | 'all'; status: ContextMenuStatus | 'all' }): ContextMenuEntry[] {
  const search = filters.search.trim().toLowerCase()
  return entries.filter((e) => {
    if (filters.scope !== 'all' && e.scope !== filters.scope) return false
    if (filters.source !== 'all' && e.source !== filters.source) return false
    if (filters.status !== 'all' && e.status !== filters.status) return false
    if (search) {
      const haystack = [e.displayName, e.name, e.command ?? '', e.dllPath ?? '', e.clsid ?? '']
        .join(' ').toLowerCase()
      if (!haystack.includes(search)) return false
    }
    return true
  })
}

function groupBySource(entries: ContextMenuEntry[]): { source: ContextMenuSource; entries: ContextMenuEntry[] }[] {
  const map = new Map<ContextMenuSource, ContextMenuEntry[]>()
  for (const e of entries) {
    const list = map.get(e.source) ?? []
    list.push(e)
    map.set(e.source, list)
  }
  return Array.from(map.entries()).map(([source, list]) => ({ source, entries: list }))
}

interface EntryRowProps {
  entry: ContextMenuEntry
  isLast: boolean
  onToggle: () => void
  onAction: (action: ContextMenuAction) => void
}

function EntryRow({ entry, isLast, onToggle, onAction }: EntryRowProps) {
  const { t } = useTranslation('contextMenu')
  const subline = entry.command || entry.dllPath || entry.clsid || entry.keyPath
  return (
    <div className="flex items-center gap-3 px-5 py-3 transition-colors"
      style={{
        background: entry.selected ? 'rgba(245,158,11,0.04)' : 'transparent',
        borderBottom: !isLast ? '1px solid var(--bg-subtle)' : 'none',
        opacity: entry.protected ? 0.7 : 1,
      }}>
      <div className="w-6 shrink-0">
        <input type="checkbox"
          checked={entry.selected}
          disabled={entry.protected}
          onChange={onToggle}
          className="accent-amber-500"
          aria-label={`select ${entry.displayName}`} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-[13px] text-zinc-200">{entry.displayName}</p>
          <span className="rounded px-1.5 py-0.5 text-[10px] font-medium"
            style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>
            {t(SCOPE_LABEL_KEY[entry.scope])}
          </span>
          {entry.kind === 'handler' && (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>
              {t('kindHandler')}
            </span>
          )}
          {entry.protected && (
            <span title={t('protectedTooltip')} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>
              <Lock className="h-2.5 w-2.5" strokeWidth={2} /> {t('protectedBadge')}
            </span>
          )}
          {entry.requiresAdmin && (
            <span title={t('adminTooltip')} className="rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{ background: 'rgba(245,158,11,0.10)', color: '#f59e0b' }}>
              {t('adminBadge')}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate font-mono text-[10px]" style={{ color: 'var(--text-muted)' }} title={subline}>
          {subline}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <span className="rounded-md px-2 py-0.5 text-[11px] font-medium"
          style={{
            background: entry.status === 'enabled' ? 'rgba(34,197,94,0.10)' : 'var(--bg-hover)',
            color: entry.status === 'enabled' ? '#22c55e' : 'var(--text-muted)',
          }}>
          {entry.status === 'enabled' ? t('statusEnabled') : t('statusDisabled')}
        </span>
        <span className="rounded-md px-2 py-0.5 text-[11px] font-medium"
          style={{ background: SOURCE_PILL_COLOR[entry.source].bg, color: SOURCE_PILL_COLOR[entry.source].text }}>
          {entry.source}
        </span>
        {!entry.protected && (
          <div className="flex items-center gap-1">
            {entry.status === 'enabled' ? (
              <button onClick={() => onAction('disable')}
                title={t('actionDisable')}
                className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
                style={{ background: 'var(--bg-hover)' }}>
                <Power className="h-3.5 w-3.5" style={{ color: 'var(--text-secondary)' }} strokeWidth={2} />
              </button>
            ) : (
              <button onClick={() => onAction('enable')}
                title={t('actionEnable')}
                className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
                style={{ background: 'rgba(34,197,94,0.10)' }}>
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2} />
              </button>
            )}
            <button onClick={() => onAction('delete')}
              title={t('actionDelete')}
              className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
              style={{ background: 'rgba(239,68,68,0.08)' }}>
              <Trash2 className="h-3.5 w-3.5 text-red-400" strokeWidth={2} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

interface FilterBarProps {
  filters: { search: string; scope: ContextMenuScope | 'all'; source: ContextMenuSource | 'all'; status: ContextMenuStatus | 'all' }
  availableScopes: ContextMenuScope[]
  availableSources: ContextMenuSource[]
  onChange: <K extends 'search' | 'scope' | 'source' | 'status'>(key: K, value: FilterBarProps['filters'][K]) => void
}

function FilterBar({ filters, availableScopes, availableSources, onChange }: FilterBarProps) {
  const { t } = useTranslation('contextMenu')
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[240px]">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
          style={{ color: 'var(--text-muted)' }} strokeWidth={2} />
        <input type="text"
          value={filters.search}
          onChange={(e) => onChange('search', e.target.value)}
          placeholder={t('filterSearchPlaceholder')}
          className="w-full rounded-xl pl-9 pr-3 py-2 text-[12px] text-zinc-200 transition-colors outline-none"
          style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-default)' }} />
      </div>
      <select value={filters.scope}
        onChange={(e) => onChange('scope', e.target.value as ContextMenuScope | 'all')}
        className="rounded-xl px-3 py-2 text-[12px] text-zinc-200 outline-none"
        style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-default)' }}>
        <option value="all">{t('filterScopeAll')}</option>
        {availableScopes.map((s) => (
          <option key={s} value={s}>{t(SCOPE_LABEL_KEY[s])}</option>
        ))}
      </select>
      <select value={filters.source}
        onChange={(e) => onChange('source', e.target.value as ContextMenuSource | 'all')}
        className="rounded-xl px-3 py-2 text-[12px] text-zinc-200 outline-none"
        style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-default)' }}>
        <option value="all">{t('filterSourceAll')}</option>
        {availableSources.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      <select value={filters.status}
        onChange={(e) => onChange('status', e.target.value as ContextMenuStatus | 'all')}
        className="rounded-xl px-3 py-2 text-[12px] text-zinc-200 outline-none"
        style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-default)' }}>
        <option value="all">{t('filterStatusAll')}</option>
        <option value="enabled">{t('filterStatusEnabled')}</option>
        <option value="disabled">{t('filterStatusDisabled')}</option>
      </select>
    </div>
  )
}
