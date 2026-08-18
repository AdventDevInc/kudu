import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
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

const ISSUE_KEYS: Record<FirewallIssue, string> = {
  'stale': 'issueStale',
  'unsigned': 'issueUnsigned',
  'broad-scope': 'issueBroadScope',
  'any-remote': 'issueAnyRemote',
}

const ISSUE_ICON: Record<FirewallIssue, typeof FileX> = {
  'stale': FileX,
  'unsigned': FileWarning,
  'broad-scope': Globe,
  'any-remote': Network,
}

export function FirewallAuditPage() {
  const { t } = useTranslation('firewallAudit')
  const rules = useFirewallStore((s) => s.rules)
  const scanning = useFirewallStore((s) => s.scanning)
  const applying = useFirewallStore((s) => s.applying)
  const scanProgress = useFirewallStore((s) => s.scanProgress)
  const applyResult = useFirewallStore((s) => s.applyResult)
  const error = useFirewallStore((s) => s.error)
  const hasScanned = useFirewallStore((s) => s.hasScanned)
  const truncated = useFirewallStore((s) => s.truncated)
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
    store.setTruncated(false)

    try {
      const result = await window.kudu.firewallScan()
      const s = useFirewallStore.getState()
      s.setRules(result.rules)
      s.setTruncated(!!result.truncated)
      s.setHasScanned(true)
    } catch (err) {
      toast.error(t('toastScanFailed'))
      useFirewallStore
        .getState()
        .setError(err instanceof Error ? err.message : t('toastScanFailed'))
    } finally {
      useFirewallStore.getState().setScanning(false)
      useFirewallStore.getState().setScanProgress(null)
    }
  }, [t])

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
      if (result.succeeded > 0) {
        const successMsg = action === 'delete'
          ? (result.succeeded === 1 ? t('rulesDeleted', { count: result.succeeded }) : t('rulesDeletedPlural', { count: result.succeeded }))
          : (result.succeeded === 1 ? t('rulesDisabled', { count: result.succeeded }) : t('rulesDisabledPlural', { count: result.succeeded }))
        toast.success(successMsg)
      }
      if (result.failed > 0) {
        const failMsg = result.failed === 1 ? t('rulesFailed', { count: result.failed }) : t('rulesFailedPlural', { count: result.failed })
        toast.error(failMsg)
      }

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
      toast.error(t('toastApplyFailed'))
      useFirewallStore
        .getState()
        .setError(err instanceof Error ? err.message : t('toastApplyFailed'))
    } finally {
      useFirewallStore.getState().setApplying(false)
    }
  }, [t])

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
      { key: 'high', label: t('groupHighRisk'), rules: filteredRules.filter((r) => r.risk === 'high') },
      { key: 'medium', label: t('groupMediumRisk'), rules: filteredRules.filter((r) => r.risk === 'medium') },
      { key: 'low', label: t('groupLowRisk'), rules: filteredRules.filter((r) => r.risk === 'low') },
    ]
    return groups.filter((g) => g.rules.length > 0)
  }, [filteredRules, t])

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
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
          {scanning ? t('scanningButton') : t('scanButton')}
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
              {t('selectStale', { count: staleCount })}
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
              {t('disableSelected', { count: selectedCount })}
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
              {t('deleteSelected')}
            </button>
          </>
        )}
      </div>

      {/* Stats banner */}
      {hasScanned && rules.length > 0 && (
        <div className="mb-5 grid grid-cols-4 gap-3">
          <StatBox label={t('statTotalInbound')} value={rules.length} icon={Inbox} color="var(--text-muted)" />
          <StatBox label={t('statStaleProgram')} value={staleCount} icon={FileX} color="#ef4444" />
          <StatBox label={t('statUnsigned')} value={unsignedCount} icon={FileWarning} color="#f59e0b" />
          <StatBox label={t('statBroadScope')} value={broadScopeCount} icon={Globe} color="#ef4444" />
        </div>
      )}

      {error && (
        <ErrorAlert
          message={error}
          onDismiss={() => useFirewallStore.getState().setError(null)}
          className="mb-5"
        />
      )}

      {/* A partial rule set is still worth acting on, but it must not read as a
          complete audit — rules Windows never returned aren't "clean". */}
      {truncated && !scanning && (
        <div
          className="mb-5 flex items-start gap-2.5 rounded-xl p-3.5"
          style={{ background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.3)' }}
        >
          <AlertTriangle className="mt-px h-4 w-4 shrink-0" style={{ color: '#f59e0b' }} strokeWidth={2} />
          <span className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
            {t('scanTruncatedNotice')}
          </span>
        </div>
      )}

      {scanning && scanProgress && (
        <div
          className="mb-5 rounded-xl p-4"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--border-medium)' }}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12.5px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              {scanProgress.phase === 'enumerating' ? t('scanProgressEnumerating') : scanProgress.phase === 'classifying' ? t('scanProgressClassifying') : t('scanProgressVerifying')}
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
              {t('applySucceeded', { count: applyResult.succeeded })}
              {applyResult.failed > 0 && t('applyFailedCount', { count: applyResult.failed })}
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
          title={t('emptyStateNoScanTitle')}
          description={t('emptyStateNoScanDesc')}
          action={
            <button
              onClick={handleScan}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all"
              style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', color: 'var(--text-on-accent)' }}
            >
              <RefreshCw className="h-4 w-4" strokeWidth={1.8} />
              {t('scanRulesButton')}
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
                placeholder={t('searchPlaceholder')}
                className="w-full rounded-lg border-0 px-3 py-2 pl-9 text-[13px] outline-none"
                style={{ background: 'var(--card-bg)', border: '1px solid var(--border-medium)', color: 'var(--text-primary)' }}
              />
            </div>
            <FilterSelect
              value={riskFilter}
              onChange={(v) => useFirewallStore.getState().setRiskFilter(v as 'all' | FirewallRiskLevel)}
              options={[
                { value: 'all', label: t('filterAllRisks') },
                { value: 'high', label: t('filterHighRisk') },
                { value: 'medium', label: t('filterMediumRisk') },
                { value: 'low', label: t('filterLowRisk') },
              ]}
            />
            <FilterSelect
              value={programFilter}
              onChange={(v) => useFirewallStore.getState().setProgramFilter(v as 'all' | 'with-program' | 'no-program' | 'stale')}
              options={[
                { value: 'all', label: t('filterAllRules') },
                { value: 'with-program', label: t('filterWithProgram') },
                { value: 'no-program', label: t('filterNoProgram') },
                { value: 'stale', label: t('filterStaleOnly') },
              ]}
            />
            {builtinCount > 0 && (
              <label
                className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-[13px]"
                style={{ background: 'var(--card-bg)', border: '1px solid var(--border-medium)', color: 'var(--text-secondary)' }}
                title={t('builtinTooltip', { count: builtinCount })}
              >
                <input
                  type="checkbox"
                  checked={showBuiltin}
                  onChange={(e) => useFirewallStore.getState().setShowBuiltin(e.target.checked)}
                  className="h-3.5 w-3.5 cursor-pointer accent-amber-500"
                />
                {t('showBuiltin', { count: builtinCount })}
              </label>
            )}
          </div>

          {filteredRules.length === 0 ? (
            <EmptyState
              icon={Search}
              title={t('emptyStateNoMatchTitle')}
              description={t('emptyStateNoMatchDesc')}
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
        title={pendingAction === 'delete' ? t('confirmDeleteTitle') : t('confirmDisableTitle')}
        description={
          pendingAction === 'delete'
            ? t('confirmDeleteDesc', { count: selectedCount })
            : t('confirmDisableDesc', { count: selectedCount })
        }
        variant={pendingAction === 'delete' ? 'danger' : 'warning'}
        confirmLabel={pendingAction === 'delete' ? t('confirmDeleteLabel') : t('confirmDisableLabel')}
      />
    </div>
  )
}

function RuleRow({ rule }: { rule: FirewallRule }) {
  const { t } = useTranslation('firewallAudit')
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
          <span>{t('ruleProfiles')} <span className="text-zinc-300">{rule.profiles.length ? rule.profiles.join(', ') : t('ruleAny')}</span></span>
          <span>{rule.protocol} {rule.localPort !== 'Any' && `· ${t('rulePort', { port: rule.localPort })}`}</span>
          <span>{t('ruleRemote')} <span className="text-zinc-300">{rule.remoteAddress}</span></span>
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
              const key = ISSUE_KEYS[issue]
              return (
                <span
                  key={issue}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium"
                  style={{ background: colors.bg, color: colors.text, border: `1px solid ${colors.border}` }}
                >
                  <Icon className="h-3 w-3" strokeWidth={2} />
                  {key ? t(key) : issue}
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
