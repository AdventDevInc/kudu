import { useState, useCallback, useEffect, useMemo } from 'react'
import {
  ShieldAlert,
  Search,
  ShieldOff,
  Trash2,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Sparkles,
  Globe,
  FileX,
  FileWarning,
  Network,
  Inbox,
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { ErrorAlert } from '@/components/shared/ErrorAlert'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useFirewallStore } from '@/stores/firewall-store'
import type {
  FirewallScanProgress,
  FirewallRule,
  FirewallRiskLevel,
  FirewallIssue,
  FirewallAction,
} from '@shared/types'

const RISK_COLORS: Record<FirewallRiskLevel, { dot: string; bg: string; border: string; text: string }> = {
  high:   { dot: '#ef4444', bg: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.20)', text: '#ef4444' },
  medium: { dot: '#f59e0b', bg: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.20)', text: '#f59e0b' },
  low:    { dot: '#22c55e', bg: 'rgba(34,197,94,0.10)',  border: 'rgba(34,197,94,0.20)',  text: '#22c55e' },
}

const ISSUE_LABEL: Record<FirewallIssue, string> = {
  'stale': 'Program missing',
  'unsigned': 'Unsigned binary',
  'broad-scope': 'Public + Any port + Any IP',
  'any-remote': 'Any remote IP',
}

const ISSUE_ICON: Record<FirewallIssue, typeof FileX> = {
  'stale': FileX,
  'unsigned': FileWarning,
  'broad-scope': Globe,
  'any-remote': Network,
}

export function FirewallAuditPage() {
  const rules = useFirewallStore((s) => s.rules)
  const scanning = useFirewallStore((s) => s.scanning)
  const applying = useFirewallStore((s) => s.applying)
  const scanProgress = useFirewallStore((s) => s.scanProgress)
  const applyResult = useFirewallStore((s) => s.applyResult)
  const error = useFirewallStore((s) => s.error)
  const hasScanned = useFirewallStore((s) => s.hasScanned)
  const searchQuery = useFirewallStore((s) => s.searchQuery)
  const riskFilter = useFirewallStore((s) => s.riskFilter)
  const programFilter = useFirewallStore((s) => s.programFilter)
  const showBuiltin = useFirewallStore((s) => s.showBuiltin)

  const [pendingAction, setPendingAction] = useState<FirewallAction | null>(null)
  const isBusy = scanning || applying

  useEffect(() => {
    const cleanup = window.kudu?.onFirewallProgress?.((data: FirewallScanProgress) => {
      useFirewallStore.getState().setScanProgress(data)
    })
    return () => { cleanup?.() }
  }, [])

  const handleScan = useCallback(async () => {
    const store = useFirewallStore.getState()
    store.setScanning(true)
    store.setRules([])
    store.setApplyResult(null)
    store.setError(null)
    store.setScanProgress(null)

    try {
      const result = await window.kudu.firewallScan()
      const s = useFirewallStore.getState()
      s.setRules(result.rules)
      s.setHasScanned(true)
    } catch (err) {
      toast.error('Firewall scan failed')
      useFirewallStore
        .getState()
        .setError(err instanceof Error ? err.message : 'Scan failed')
    } finally {
      useFirewallStore.getState().setScanning(false)
      useFirewallStore.getState().setScanProgress(null)
    }
  }, [])

  // Auto-scan on first visit
  useEffect(() => {
    if (!hasScanned && !scanning) handleScan()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleApply = useCallback(async (action: FirewallAction) => {
    setPendingAction(null)
    const store = useFirewallStore.getState()
    const selected = store.rules.filter((r) => r.selected)
    if (selected.length === 0) return

    store.setApplying(true)
    store.setApplyResult(null)
    store.setError(null)

    try {
      const result = await window.kudu.firewallApply(
        selected.map((r) => ({ name: r.name, action }))
      )
      useFirewallStore.getState().setApplyResult(result)
      const verb = action === 'delete' ? 'deleted' : 'disabled'
      if (result.succeeded > 0) toast.success(`${result.succeeded} rule${result.succeeded === 1 ? '' : 's'} ${verb}`)
      if (result.failed > 0) toast.error(`${result.failed} rule${result.failed === 1 ? '' : 's'} failed`)

      // The scan only enumerates enabled rules, so both delete and disable
      // mean the rule should disappear from the list. Prune locally instead
      // of re-scanning — the full re-scan takes 30-90s on a typical system.
      const failedNames = new Set(result.errors.map((e) => e.name).filter(Boolean))
      const requestedNames = new Set(selected.map((r) => r.name))
      useFirewallStore.getState().setRules(
        useFirewallStore.getState().rules.filter(
          (r) => !requestedNames.has(r.name) || failedNames.has(r.name)
        )
      )
    } catch (err) {
      toast.error('Failed to update firewall rules')
      useFirewallStore
        .getState()
        .setError(err instanceof Error ? err.message : 'Apply failed')
    } finally {
      useFirewallStore.getState().setApplying(false)
    }
  }, [])

  const handleSelectStale = useCallback(() => {
    useFirewallStore.getState().selectRecommended()
  }, [])

  const filteredRules = useMemo(() => {
    let result = rules

    // Built-in / Microsoft / AppX rules are hidden by default. Stale built-ins
    // are still surfaced because a leftover rule pointing at a removed Windows
    // feature is genuinely worth cleaning up — toggle handles only the noise.
    if (!showBuiltin) result = result.filter((r) => !r.builtin || r.issues.includes('stale'))

    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.displayName.toLowerCase().includes(q) ||
          r.group.toLowerCase().includes(q) ||
          r.programResolved.toLowerCase().includes(q)
      )
    }
    if (riskFilter !== 'all') result = result.filter((r) => r.risk === riskFilter)
    if (programFilter === 'with-program') result = result.filter((r) => !!r.programResolved)
    else if (programFilter === 'no-program') result = result.filter((r) => !r.programResolved)
    else if (programFilter === 'stale') result = result.filter((r) => r.issues.includes('stale'))

    return result
  }, [rules, searchQuery, riskFilter, programFilter, showBuiltin])

  const builtinCount = useMemo(
    () => rules.filter((r) => r.builtin && !r.issues.includes('stale')).length,
    [rules]
  )

  const selectedCount = rules.filter((r) => r.selected).length
  const staleCount = rules.filter((r) => r.issues.includes('stale')).length
  const unsignedCount = rules.filter((r) => r.issues.includes('unsigned')).length
  const broadScopeCount = rules.filter((r) => r.issues.includes('broad-scope')).length

  const riskGroups = useMemo(() => {
    const groups: { key: FirewallRiskLevel; label: string; rules: FirewallRule[] }[] = [
      { key: 'high', label: 'High risk', rules: filteredRules.filter((r) => r.risk === 'high') },
      { key: 'medium', label: 'Medium risk', rules: filteredRules.filter((r) => r.risk === 'medium') },
      { key: 'low', label: 'Low risk', rules: filteredRules.filter((r) => r.risk === 'low') },
    ]
    return groups.filter((g) => g.rules.length > 0)
  }, [filteredRules])

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <PageHeader
        title="Firewall Audit"
        description="Review inbound Windows Firewall rules. Disable or delete entries with broad scope, missing programs, or unsigned binaries."
      />

      {/* Action bar */}
      <div className="mb-5 flex items-center gap-3">
        <button
          onClick={handleScan}
          disabled={isBusy}
          className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-[13px] font-semibold text-white transition-all"
          style={{ background: isBusy ? '#27272a' : 'var(--accent)', opacity: isBusy ? 0.5 : 1 }}
        >
          {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" strokeWidth={2} />}
          {scanning ? 'Scanning…' : 'Rescan'}
        </button>

        {hasScanned && (
          <>
            <button
              onClick={handleSelectStale}
              disabled={isBusy || staleCount === 0}
              className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-[13px] font-medium transition-all"
              style={{
                background: 'rgba(34,197,94,0.10)',
                color: '#22c55e',
                border: '1px solid rgba(34,197,94,0.20)',
                opacity: isBusy || staleCount === 0 ? 0.5 : 1,
              }}
            >
              <Sparkles className="h-4 w-4" strokeWidth={2} />
              Select stale ({staleCount})
            </button>

            <button
              onClick={() => setPendingAction('disable')}
              disabled={isBusy || selectedCount === 0}
              className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-[13px] font-semibold text-white transition-all"
              style={{
                background: selectedCount > 0 && !isBusy ? '#f59e0b' : '#27272a',
                opacity: isBusy || selectedCount === 0 ? 0.5 : 1,
              }}
            >
              {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldOff className="h-4 w-4" strokeWidth={2} />}
              Disable selected ({selectedCount})
            </button>

            <button
              onClick={() => setPendingAction('delete')}
              disabled={isBusy || selectedCount === 0}
              className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-[13px] font-semibold text-white transition-all"
              style={{
                background: selectedCount > 0 && !isBusy ? '#dc2626' : '#27272a',
                opacity: isBusy || selectedCount === 0 ? 0.5 : 1,
              }}
            >
              <Trash2 className="h-4 w-4" strokeWidth={2} />
              Delete selected
            </button>
          </>
        )}
      </div>

      {/* Stats banner */}
      {hasScanned && rules.length > 0 && (
        <div className="mb-5 grid grid-cols-4 gap-3">
          <StatBox label="Total inbound" value={rules.length} icon={Inbox} color="var(--text-muted)" />
          <StatBox label="Stale program" value={staleCount} icon={FileX} color="#ef4444" />
          <StatBox label="Unsigned" value={unsignedCount} icon={FileWarning} color="#f59e0b" />
          <StatBox label="Broad scope" value={broadScopeCount} icon={Globe} color="#ef4444" />
        </div>
      )}

      {error && (
        <ErrorAlert
          message={error}
          onDismiss={() => useFirewallStore.getState().setError(null)}
          className="mb-5"
        />
      )}

      {scanning && scanProgress && (
        <div
          className="mb-5 rounded-xl p-4"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--border-medium)' }}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12.5px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              {scanProgress.phase === 'enumerating' ? 'Enumerating rules…' : scanProgress.phase === 'classifying' ? 'Classifying rules…' : 'Verifying signatures…'}
            </span>
            {scanProgress.total > 0 && (
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {scanProgress.current} / {scanProgress.total}
              </span>
            )}
          </div>
          {scanProgress.total > 0 && (
            <div className="h-1.5 overflow-hidden rounded-full" style={{ background: '#27272a' }}>
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ background: 'var(--accent)', width: `${Math.round((scanProgress.current / scanProgress.total) * 100)}%` }}
              />
            </div>
          )}
          <div className="mt-1.5 truncate text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            {scanProgress.currentRule}
          </div>
        </div>
      )}

      {applyResult && (
        <div
          className="mb-5 rounded-xl p-4"
          style={{
            background: applyResult.failed > 0 ? 'rgba(245,158,11,0.06)' : 'rgba(34,197,94,0.06)',
            border: `1px solid ${applyResult.failed > 0 ? 'rgba(245,158,11,0.15)' : 'rgba(34,197,94,0.15)'}`,
          }}
        >
          <div className="flex items-center gap-2">
            {applyResult.failed > 0 ? (
              <AlertTriangle className="h-4 w-4" style={{ color: '#f59e0b' }} />
            ) : (
              <CheckCircle2 className="h-4 w-4" style={{ color: '#22c55e' }} />
            )}
            <span className="text-[13px] font-medium text-white">
              {applyResult.succeeded} succeeded
              {applyResult.failed > 0 && `, ${applyResult.failed} failed`}
            </span>
          </div>
          {applyResult.errors.length > 0 && (
            <div className="mt-2 space-y-1">
              {applyResult.errors.map((e, i) => (
                <div key={i} className="text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>
                  {e.displayName || e.name}: {e.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!hasScanned && !scanning && (
        <EmptyState
          icon={ShieldAlert}
          title="No scan yet"
          description="Scan to review inbound firewall rules and flag anything suspicious."
          action={
            <button
              onClick={handleScan}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all"
              style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', color: 'var(--text-on-accent)' }}
            >
              <RefreshCw className="h-4 w-4" strokeWidth={1.8} />
              Scan firewall rules
            </button>
          }
        />
      )}

      {hasScanned && rules.length > 0 && (
        <>
          {/* Filters */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[240px]">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
                style={{ color: 'var(--text-muted)' }}
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => useFirewallStore.getState().setSearchQuery(e.target.value)}
                placeholder="Search rules, programs, groups…"
                className="w-full rounded-lg border-0 px-3 py-2 pl-9 text-[13px] outline-none"
                style={{ background: 'var(--card-bg)', border: '1px solid var(--border-medium)', color: 'var(--text-primary)' }}
              />
            </div>
            <FilterSelect
              value={riskFilter}
              onChange={(v) => useFirewallStore.getState().setRiskFilter(v as 'all' | FirewallRiskLevel)}
              options={[
                { value: 'all', label: 'All risk levels' },
                { value: 'high', label: 'High risk' },
                { value: 'medium', label: 'Medium risk' },
                { value: 'low', label: 'Low risk' },
              ]}
            />
            <FilterSelect
              value={programFilter}
              onChange={(v) => useFirewallStore.getState().setProgramFilter(v as 'all' | 'with-program' | 'no-program' | 'stale')}
              options={[
                { value: 'all', label: 'All rules' },
                { value: 'with-program', label: 'With program' },
                { value: 'no-program', label: 'Port-only' },
                { value: 'stale', label: 'Stale only' },
              ]}
            />
            {builtinCount > 0 && (
              <label
                className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-[13px]"
                style={{ background: 'var(--card-bg)', border: '1px solid var(--border-medium)', color: 'var(--text-secondary)' }}
                title={`${builtinCount} Microsoft / system / packaged-app rule${builtinCount === 1 ? '' : 's'} hidden by default — these ship with Windows and shouldn't be removed.`}
              >
                <input
                  type="checkbox"
                  checked={showBuiltin}
                  onChange={(e) => useFirewallStore.getState().setShowBuiltin(e.target.checked)}
                  className="h-3.5 w-3.5 cursor-pointer accent-amber-500"
                />
                Show built-in ({builtinCount})
              </label>
            )}
          </div>

          {filteredRules.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No rules match"
              description="Try adjusting your filters or search query."
            />
          ) : (
            <div className="space-y-6">
              {riskGroups.map((group) => (
                <div key={group.key}>
                  <div className="mb-2 flex items-center gap-2">
                    <div
                      className="h-2 w-2 rounded-full"
                      style={{ background: RISK_COLORS[group.key].dot }}
                      aria-hidden="true"
                    />
                    <h3 className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                      {group.label}
                    </h3>
                    <span className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
                      {group.rules.length}
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {group.rules.map((r) => (
                      <RuleRow key={r.name} rule={r} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={pendingAction !== null}
        onConfirm={() => pendingAction && handleApply(pendingAction)}
        onCancel={() => setPendingAction(null)}
        title={pendingAction === 'delete' ? 'Delete firewall rules?' : 'Disable firewall rules?'}
        description={
          pendingAction === 'delete'
            ? `Permanently delete ${selectedCount} firewall rule${selectedCount === 1 ? '' : 's'}. This cannot be undone.`
            : `Disable ${selectedCount} firewall rule${selectedCount === 1 ? '' : 's'}. You can re-enable them later from Windows Firewall settings.`
        }
        variant={pendingAction === 'delete' ? 'danger' : 'warning'}
        confirmLabel={pendingAction === 'delete' ? 'Delete' : 'Disable'}
      />
    </div>
  )
}

function RuleRow({ rule }: { rule: FirewallRule }) {
  const colors = RISK_COLORS[rule.risk]
  return (
    <label
      className="flex cursor-pointer items-start gap-3 rounded-xl px-4 py-3 transition-colors"
      style={{
        background: rule.selected ? colors.bg : 'var(--card-bg)',
        border: `1px solid ${rule.selected ? colors.border : 'var(--border-medium)'}`,
      }}
    >
      <input
        type="checkbox"
        checked={rule.selected}
        onChange={() => useFirewallStore.getState().toggleRule(rule.name)}
        className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-amber-500"
        aria-label={`Select rule ${rule.displayName}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-white">{rule.displayName}</span>
          {rule.group && (
            <span
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{ background: 'var(--bg-subtle)', color: 'var(--text-muted)' }}
            >
              {rule.group}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          <span>Profiles: <span className="text-zinc-300">{rule.profiles.length ? rule.profiles.join(', ') : 'Any'}</span></span>
          <span>{rule.protocol} {rule.localPort !== 'Any' && `· port ${rule.localPort}`}</span>
          <span>Remote: <span className="text-zinc-300">{rule.remoteAddress}</span></span>
        </div>
        {rule.programResolved && (
          <div className="mt-1 truncate font-mono text-[11px]" style={{ color: rule.programExists ? 'var(--text-muted)' : '#ef4444' }} title={rule.programResolved}>
            {rule.programResolved}
          </div>
        )}
        {rule.issues.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {rule.issues.map((issue) => {
              const Icon = ISSUE_ICON[issue]
              return (
                <span
                  key={issue}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium"
                  style={{ background: colors.bg, color: colors.text, border: `1px solid ${colors.border}` }}
                >
                  <Icon className="h-3 w-3" strokeWidth={2} />
                  {ISSUE_LABEL[issue]}
                </span>
              )
            })}
          </div>
        )}
      </div>
    </label>
  )
}

function StatBox({ label, value, icon: Icon, color }: { label: string; value: number; icon: typeof Inbox; color: string }) {
  return (
    <div
      className="flex items-center gap-3 rounded-xl px-4 py-3"
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border-medium)' }}
    >
      <Icon className="h-4 w-4 shrink-0" style={{ color }} strokeWidth={2} />
      <div className="min-w-0">
        <div className="text-[18px] font-semibold tabular-nums text-white">{value}</div>
        <div className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
      </div>
    </div>
  )
}

function FilterSelect({ value, onChange, options }: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border-0 px-3 py-2 text-[13px] outline-none"
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border-medium)', color: 'var(--text-primary)' }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}
