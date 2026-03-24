import { useEffect, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  ShieldCheck,
  Search,
  RefreshCw,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { cn } from '@/lib/utils'
import { useCveStore } from '@/stores/cve-store'
import { useSettingsStore } from '@/stores/settings-store'
import type { CveVulnerability, CveSeverity } from '@shared/types'

const severityConfig: Record<string, { color: string; bg: string; border: string }> = {
  critical: { color: '#ef4444', bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.15)' },
  high:     { color: '#f97316', bg: 'rgba(249,115,22,0.08)', border: 'rgba(249,115,22,0.15)' },
}

const shownSeverities: CveSeverity[] = ['critical', 'high']

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString()
  } catch {
    return iso
  }
}

export function CveScannerPage() {
  const { t } = useTranslation('cveScanner')
  const navigate = useNavigate()
  const settings = useSettingsStore((s) => s.settings)
  const isLinked = !!settings.cloud.apiKey

  const vulnerabilities = useCveStore((s) => s.vulnerabilities)
  const status = useCveStore((s) => s.status)
  const error = useCveStore((s) => s.error)
  const page = useCveStore((s) => s.page)
  const total = useCveStore((s) => s.total)
  const hasNextPage = useCveStore((s) => s.hasNextPage)
  const severityFilter = useCveStore((s) => s.severityFilter)
  const searchQuery = useCveStore((s) => s.searchQuery)
  const summary = useCveStore((s) => s.summary)
  const expandedId = useCveStore((s) => s.expandedId)
  const fetchVulns = useCveStore((s) => s.fetch)
  const setSeverityFilter = useCveStore((s) => s.setSeverityFilter)
  const setSearchQuery = useCveStore((s) => s.setSearchQuery)
  const setExpandedId = useCveStore((s) => s.setExpandedId)

  const [searchInput, setSearchInput] = useState(searchQuery)

  // Auto-fetch on mount if linked, with retry for cold-start race
  // (cloud agent may still be connecting when the page mounts)
  useEffect(() => {
    if (!isLinked) return
    if (status === 'idle') {
      fetchVulns()
      return
    }
    // If first fetch failed with "not connected", retry after agent has time to connect
    if (status === 'done' && error?.includes('not connected')) {
      const timer = setTimeout(() => fetchVulns(), 3000)
      return () => clearTimeout(timer)
    }
  }, [isLinked, status, error, fetchVulns])

  // Show toast on error (skip "not connected" — we retry that silently)
  useEffect(() => {
    if (error && !error.includes('not connected')) {
      toast.error(t('toast.fetchFailed'))
    }
  }, [error, t])

  const handleRefresh = useCallback(() => {
    fetchVulns({ page: 1 })
  }, [fetchVulns])

  const handleSeverityChange = useCallback((filter: typeof severityFilter) => {
    setSeverityFilter(filter)
    fetchVulns({ page: 1, severity: filter })
  }, [setSeverityFilter, fetchVulns])

  const handleSearch = useCallback(() => {
    setSearchQuery(searchInput)
    fetchVulns({ page: 1, search: searchInput })
  }, [searchInput, setSearchQuery, fetchVulns])

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch()
  }, [handleSearch])

  const handlePageChange = useCallback((newPage: number) => {
    fetchVulns({ page: newPage })
  }, [fetchVulns])

  // Cloud not configured — redirect away (page is hidden from sidebar)
  useEffect(() => {
    if (!isLinked) navigate('/', { replace: true })
  }, [isLinked, navigate])
  if (!isLinked) return null

  // Loading (first fetch)
  if (status === 'loading' && vulnerabilities.length === 0 && !error) {
    return (
      <div className="p-8">
        <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
        <div className="flex items-center justify-center py-20">
          <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>{t('loading')}</div>
        </div>
      </div>
    )
  }

  const totalVulns = summary ? summary.critical + summary.high : 0
  const isLoading = status === 'loading'
  const filteredVulns = vulnerabilities.filter((v) => v.severity === 'critical' || v.severity === 'high')

  return (
    <div className="p-8 animate-fade-in">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        action={
          <button
            onClick={handleRefresh}
            disabled={isLoading}
            className={cn(
              'flex items-center gap-2 rounded-lg px-4 py-2 text-[13px] font-medium transition-colors',
              isLoading
                ? 'cursor-not-allowed opacity-50'
                : 'bg-white/5 text-zinc-300 hover:bg-white/10'
            )}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
            {t('refetchButton')}
          </button>
        }
      />

      {/* Summary cards */}
      {summary && (
        <div className="mb-6 grid grid-cols-3 gap-3">
          <SummaryCard label={t('summary.total')} count={totalVulns} color="#a1a1aa" />
          <SummaryCard label={t('summary.critical')} count={summary.critical} color="#ef4444" />
          <SummaryCard label={t('summary.high')} count={summary.high} color="#f97316" />
        </div>
      )}

      {/* Filters */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        {/* Severity tabs */}
        <div
          className="flex rounded-lg p-0.5"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}
        >
          {(['all', ...shownSeverities] as const).map((sev) => {
            const isActive = severityFilter === sev
            return (
              <button
                key={sev}
                onClick={() => handleSeverityChange(sev as typeof severityFilter)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
                  isActive
                    ? 'bg-white/10 text-zinc-200'
                    : 'text-zinc-500 hover:text-zinc-300'
                )}
              >
                {sev === 'all' ? t('filter.all') : t(`severity.${sev}`)}
              </button>
            )
          })}
        </div>

        {/* Search */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            onBlur={handleSearch}
            placeholder={t('filter.searchPlaceholder')}
            className="w-full rounded-lg py-2 pl-9 pr-3 text-[13px] text-zinc-300 placeholder-zinc-600 outline-none"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}
          />
        </div>
      </div>

      {/* Error state */}
      {status === 'done' && error && (
        <EmptyState
          icon={AlertTriangle}
          title={t('error.title')}
          description={t('error.description')}
        />
      )}

      {/* No results — use filtered list for display */}
      {status === 'done' && filteredVulns.length === 0 && !error && (
        <EmptyState
          icon={totalVulns === 0 ? ShieldCheck : Search}
          title={totalVulns === 0 ? t('emptyState.title') : t('filter.noResults')}
          description={totalVulns === 0 ? t('emptyState.description') : ''}
        />
      )}

      {/* Vulnerability list */}
      {filteredVulns.length > 0 && (
        <div className="space-y-2">
          {filteredVulns.map((vuln) => (
            <VulnerabilityCard
              key={`${vuln.id}-${vuln.cveId}`}
              vuln={vuln}
              expanded={expandedId === vuln.cveId}
              onToggle={() => setExpandedId(expandedId === vuln.cveId ? null : vuln.cveId)}
              onNavigateUpdater={() => navigate('/updates')}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {(page > 1 || hasNextPage) && (
        <div className="mt-6 flex items-center justify-center gap-4">
          <button
            onClick={() => handlePageChange(page - 1)}
            disabled={page <= 1 || isLoading}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-medium transition-colors',
              page <= 1 || isLoading
                ? 'cursor-not-allowed text-zinc-700'
                : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
            )}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {t('pagination.previous')}
          </button>
          <span className="text-[12px] text-zinc-500">
            {t('pagination.page', { current: page })}
          </span>
          <button
            onClick={() => handlePageChange(page + 1)}
            disabled={!hasNextPage || isLoading}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-medium transition-colors',
              !hasNextPage || isLoading
                ? 'cursor-not-allowed text-zinc-700'
                : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
            )}
          >
            {t('pagination.next')}
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

function SummaryCard({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div
      className="rounded-xl px-4 py-3"
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}
    >
      <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {label}
      </div>
      <div className="mt-1 text-[22px] font-bold" style={{ color }}>
        {count}
      </div>
    </div>
  )
}

function VulnerabilityCard({
  vuln,
  expanded,
  onToggle,
  onNavigateUpdater,
  t,
}: {
  vuln: CveVulnerability
  expanded: boolean
  onToggle: () => void
  onNavigateUpdater: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const config = severityConfig[vuln.severity] || severityConfig.critical

  return (
    <div
      className="rounded-xl transition-colors"
      style={{ background: config.bg, border: `1px solid ${config.border}` }}
    >
      {/* Header row — always visible */}
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform', expanded && 'rotate-180')}
        />

        {/* App name + version */}
        <div className="min-w-0 flex-1">
          <span className="text-[13px] font-medium text-zinc-200">{vuln.appName}</span>
          <span className="ml-2 text-[12px] text-zinc-500">{vuln.installedVersion}</span>
        </div>

        {/* CVE ID */}
        <span className="shrink-0 text-[12px] font-mono text-zinc-400">{vuln.cveId}</span>

        {/* CVSS badge */}
        {vuln.cvssScore != null && (
          <span
            className="shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold"
            style={{ background: config.border, color: config.color }}
          >
            {t('card.cvss', { score: vuln.cvssScore.toFixed(1) })}
          </span>
        )}

        {/* Severity badge */}
        <span
          className="shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold uppercase"
          style={{ background: config.border, color: config.color }}
        >
          {t(`severity.${vuln.severity}`)}
        </span>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t px-4 pb-4 pt-3" style={{ borderColor: config.border }}>
          {/* Description */}
          {vuln.description && (
            <p className="mb-3 text-[12px] leading-relaxed text-zinc-400">
              {vuln.description}
            </p>
          )}

          <div className="flex flex-wrap gap-x-6 gap-y-2 text-[12px]">
            {/* Fix version */}
            <div>
              <span className="text-zinc-500">
                {vuln.fixedIn
                  ? t('card.fixAvailable', { version: vuln.fixedIn })
                  : t('card.noFix')}
              </span>
            </div>

            {/* Installed version */}
            <div className="text-zinc-500">
              {t('card.installed', { version: vuln.installedVersion })}
            </div>

            {/* First detected */}
            <div className="text-zinc-500">
              {t('card.firstDetected', { date: formatDate(vuln.firstDetectedAt) })}
            </div>

            {/* Last scanned */}
            <div className="text-zinc-500">
              {t('card.lastScanned', { date: formatDate(vuln.lastScannedAt) })}
            </div>
          </div>

          {/* Actions */}
          <div className="mt-3 flex flex-wrap gap-2">
            {/* NVD link — always available */}
            <a
              href={`https://nvd.nist.gov/vuln/detail/${vuln.cveId}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium text-zinc-300 transition-colors hover:bg-white/5"
              style={{ border: '1px solid var(--border-strong)' }}
            >
              <ExternalLink className="h-3 w-3" />
              {t('card.viewDetails')}
            </a>

            {/* Navigate to updater — only if a fix version exists */}
            {vuln.fixedIn && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onNavigateUpdater()
                }}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium text-zinc-300 transition-colors hover:bg-white/5"
                style={{ border: '1px solid var(--border-strong)' }}
              >
                <RefreshCw className="h-3 w-3" />
                {t('card.checkForUpdates')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
