import { useEffect, useCallback, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  ShieldCheck,
  RefreshCw,
  AlertTriangle,
  Mail,
  Plus,
  Lock,
  Check,
  CheckCheck,
  ArrowUpDown,
  HelpCircle,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { cn } from '@/lib/utils'
import { useBreachStore } from '@/stores/breach-store'
import { useSettingsStore } from '@/stores/settings-store'
import type { BreachEntry } from '@shared/types'

function formatCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString()
  } catch {
    return iso
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type SortField = 'date' | 'accounts' | 'status'
type SortDir = 'asc' | 'desc'

interface FlatBreach extends BreachEntry {
  email: string
}

export function BreachMonitorPage() {
  const { t } = useTranslation('breachMonitor')
  const navigate = useNavigate()
  const settings = useSettingsStore((s) => s.settings)
  const isLinked = !!settings.cloud.apiKey

  const emails = useBreachStore((s) => s.emails)
  const limit = useBreachStore((s) => s.limit)
  const usage = useBreachStore((s) => s.usage)
  const status = useBreachStore((s) => s.status)
  const error = useBreachStore((s) => s.error)
  const addingEmail = useBreachStore((s) => s.addingEmail)
  const fetchBreaches = useBreachStore((s) => s.fetch)
  const addEmail = useBreachStore((s) => s.addEmail)
  const removeEmail = useBreachStore((s) => s.removeEmail)
  const acknowledgeBreaches = useBreachStore((s) => s.acknowledgeBreaches)

  const [emailInput, setEmailInput] = useState('')
  const [emailFilter, setEmailFilter] = useState<string>('all')
  const [sortField, setSortField] = useState<SortField>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  // Auto-fetch on mount (retries for "not connected" are handled by the store)
  useEffect(() => {
    if (!isLinked) return
    if (status === 'idle') fetchBreaches()
  }, [isLinked, status, fetchBreaches])

  // Toast on error
  useEffect(() => {
    if (error && !error.includes('not connected') && !error.includes('403') && emails.length > 0) {
      toast.error(t('toast.fetchFailed'))
    }
  }, [error, emails.length, t])

  const handleRefresh = useCallback(() => { fetchBreaches() }, [fetchBreaches])

  const handleAddEmail = useCallback(async () => {
    const value = emailInput.trim().toLowerCase()
    if (!value) return
    if (!EMAIL_RE.test(value)) { toast.error(t('toast.invalidEmail')); return }
    if (usage >= limit && limit > 0) { toast.error(t('toast.limitReached')); return }
    try {
      await addEmail(value)
      setEmailInput('')
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      toast.error(msg.includes('422') || msg.includes('403') ? t('toast.limitReached') : t('toast.addFailed'))
    }
  }, [emailInput, usage, limit, addEmail, t])

  const handleRemoveEmail = useCallback(async (email: string) => {
    try {
      await removeEmail(email)
      if (emailFilter === email) setEmailFilter('all')
    } catch { toast.error(t('toast.removeFailed')) }
  }, [removeEmail, emailFilter, t])

  const handleAcknowledge = useCallback(async (breachIds: string[]) => {
    try {
      await acknowledgeBreaches(breachIds)
      toast.success(t('toast.acknowledged'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      console.error('Acknowledge failed:', msg, 'breachIds:', breachIds)
      toast.error(msg || t('toast.acknowledgeFailed'))
    }
  }, [acknowledgeBreaches, t])

  const toggleSort = useCallback((field: SortField) => {
    if (sortField === field) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('desc') }
  }, [sortField])

  // Flatten all breaches with email attached, apply filter + sort
  const allBreaches = useMemo<FlatBreach[]>(() => {
    const flat: FlatBreach[] = []
    for (const em of emails) {
      for (const b of em.breaches) {
        flat.push({ ...b, email: em.email })
      }
    }
    return flat
  }, [emails])

  const filteredBreaches = useMemo(() => {
    const filtered = emailFilter === 'all'
      ? allBreaches
      : allBreaches.filter((b) => b.email === emailFilter)

    return [...filtered].sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1
      if (sortField === 'date') return dir * (new Date(a.breachDate).getTime() - new Date(b.breachDate).getTime())
      if (sortField === 'accounts') return dir * (a.pwnCount - b.pwnCount)
      const aAck = a.acknowledgedAt ? 1 : 0
      const bAck = b.acknowledgedAt ? 1 : 0
      return dir * (aAck - bAck)
    })
  }, [allBreaches, emailFilter, sortField, sortDir])

  const unacknowledgedIds = useMemo(
    () => filteredBreaches.filter((b) => !b.acknowledgedAt).map((b) => b.name),
    [filteredBreaches],
  )

  // Redirect if not linked
  useEffect(() => {
    if (!isLinked) navigate('/', { replace: true })
  }, [isLinked, navigate])
  if (!isLinked) return null

  // Loading (first fetch)
  if (status === 'loading' && emails.length === 0 && !error) {
    return (
      <div className="p-8">
        <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
        <div className="flex items-center justify-center py-20">
          <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>{t('loading')}</div>
        </div>
      </div>
    )
  }

  const is403 = error?.includes('403')
  const isLoading = status === 'loading'
  const totalBreaches = allBreaches.length
  const unacknowledgedCount = allBreaches.filter((b) => !b.acknowledgedAt).length

  const selectStyle = 'rounded-lg px-3 py-1.5 text-[13px] text-zinc-400 outline-none'
  const selectBorder = { background: 'var(--bg-subtle-2)', border: '1px solid var(--border-medium)' }

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
              isLoading ? 'cursor-not-allowed opacity-50' : 'bg-white/5 text-zinc-300 hover:bg-white/10'
            )}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
            {t('refetchButton')}
          </button>
        }
      />

      {/* 403 — upgrade required */}
      {is403 && (
        <EmptyState
          icon={Lock}
          title={t('emptyState.upgradeRequired')}
          description={t('emptyState.upgradeRequiredDesc')}
          action={
            <button
              onClick={() => window.open('https://cloud.usekudu.com/organisation/billing', '_blank')}
              className="rounded-lg px-5 py-2.5 text-[13px] font-medium text-black transition-colors"
              style={{ background: 'linear-gradient(135deg, #fbbf24, #f59e0b)' }}
            >
              {t('emptyState.goToCloud')}
            </button>
          }
        />
      )}

      {!is403 && (
        <>
          {/* Error banner */}
          {error && !error.includes('not connected') && emails.length > 0 && (
            <div
              className="mb-6 flex items-center gap-3 rounded-xl px-4 py-3 text-[13px]"
              style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: '#f87171' }}
            >
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{t('error.title')} — {t('error.description')}</span>
            </div>
          )}

          {/* Summary cards */}
          <div className="mb-6 grid grid-cols-3 gap-3">
            <SummaryCard label={t('summary.totalBreaches')} count={totalBreaches} color={totalBreaches > 0 ? '#ef4444' : '#22c55e'} />
            <SummaryCard label={t('summary.unacknowledged')} count={unacknowledgedCount} color={unacknowledgedCount > 0 ? '#f59e0b' : '#22c55e'} />
            <SummaryCard label={t('summary.emailsMonitored')} value={`${usage} / ${limit}`} color="#a1a1aa" tooltip={t('summary.emailsMonitoredTooltip')} />
          </div>

          {/* Add email row + email filter */}
          <div className="mb-5 flex items-center gap-2.5">
            <div className="relative flex-1">
              <Mail className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
              <input
                type="email"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddEmail()}
                placeholder={t('addEmail.placeholder')}
                disabled={addingEmail || (usage >= limit && limit > 0)}
                className="w-full rounded-xl py-2.5 pl-9 pr-3 text-[13px] text-zinc-300 placeholder-zinc-600 outline-none disabled:opacity-50"
                style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}
              />
            </div>
            <button
              onClick={handleAddEmail}
              disabled={addingEmail || !emailInput.trim() || (usage >= limit && limit > 0)}
              className={cn(
                'flex items-center gap-1.5 rounded-xl px-5 py-2.5 text-[13px] font-medium transition-colors',
                addingEmail || !emailInput.trim() || (usage >= limit && limit > 0)
                  ? 'cursor-not-allowed opacity-50 text-zinc-500' : 'text-black'
              )}
              style={{
                background: addingEmail || !emailInput.trim() || (usage >= limit && limit > 0)
                  ? 'var(--bg-subtle-2)' : 'linear-gradient(135deg, #fbbf24, #f59e0b)',
                border: '1px solid var(--border-medium)',
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              {addingEmail ? t('addEmail.adding') : t('addEmail.button')}
            </button>
          </div>

          {/* No emails yet */}
          {emails.length === 0 && status === 'done' && (
            <EmptyState icon={Mail} title={t('emptyState.noEmails')} description={t('emptyState.noEmailsDesc')} />
          )}

          {/* Breach table */}
          {emails.length > 0 && (
            <>
              {/* Filter bar + acknowledge all */}
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {emails.length > 1 && (
                    <select
                      value={emailFilter}
                      onChange={(e) => setEmailFilter(e.target.value)}
                      className={selectStyle}
                      style={selectBorder}
                    >
                      <option value="all">{t('filter.allEmails')}</option>
                      {emails.map((em) => (
                        <option key={em.email} value={em.email}>{em.email}</option>
                      ))}
                    </select>
                  )}
                  {/* Managed emails — remove buttons */}
                  {emails.map((em) => (
                    <span key={em.email} className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px]"
                      style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
                      {em.email}
                      <button
                        onClick={() => handleRemoveEmail(em.email)}
                        className="ml-0.5 rounded p-0.5 transition-colors hover:text-red-400"
                        title={t('emailList.remove')}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
                {unacknowledgedIds.length > 0 && (
                  <button
                    onClick={() => handleAcknowledge(unacknowledgedIds)}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
                    title={t('actions.acknowledgeAllTooltip')}
                  >
                    <CheckCheck className="h-3.5 w-3.5" />
                    {t('actions.acknowledgeAll')} ({unacknowledgedIds.length})
                  </button>
                )}
              </div>

              {/* All clear — no breaches across any email */}
              {totalBreaches === 0 && status === 'done' && (
                <EmptyState icon={ShieldCheck} title={t('emptyState.allClear')} description={t('emptyState.allClearDesc')} className="py-12" />
              )}

              {/* Table */}
              {filteredBreaches.length > 0 && (
                <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-default)' }}>
                  <table className="w-full">
                    <thead>
                      <tr style={{ background: 'var(--bg-subtle)' }}>
                        <Th>{t('table.breach')}</Th>
                        {emails.length > 1 && <Th>{t('table.email')}</Th>}
                        <ThSortable field="date" current={sortField} dir={sortDir} onSort={toggleSort}>
                          {t('table.date')}
                        </ThSortable>
                        <ThSortable field="accounts" current={sortField} dir={sortDir} onSort={toggleSort}>
                          {t('table.accounts')}
                        </ThSortable>
                        <Th>{t('table.data')}</Th>
                        <ThSortable field="status" current={sortField} dir={sortDir} onSort={toggleSort}>
                          {t('table.status')}
                        </ThSortable>
                        <Th className="w-10" />
                      </tr>
                    </thead>
                    <tbody>
                      {filteredBreaches.map((breach) => (
                        <BreachRow
                          key={`${breach.email}-${breach.name}`}
                          breach={breach}
                          showEmail={emails.length > 1}
                          onAcknowledge={() => handleAcknowledge([breach.name])}
                          t={t}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Filter active but no results */}
              {filteredBreaches.length === 0 && totalBreaches > 0 && (
                <EmptyState icon={ShieldCheck} title={t('emptyState.noBreachesForEmail')} description="" className="py-12" />
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

// ─── Table helpers ───────────────────────────────────────

function SummaryCard({ label, count, value, color, tooltip }: { label: string; count?: number; value?: string; color: string; tooltip?: string }) {
  const [showTip, setShowTip] = useState(false)
  return (
    <div className="rounded-xl px-4 py-3" style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}>
      <div className="flex items-center gap-1.5">
        <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{label}</div>
        {tooltip && (
          <div className="relative" onMouseEnter={() => setShowTip(true)} onMouseLeave={() => setShowTip(false)}>
            <HelpCircle className="h-3 w-3 cursor-help" style={{ color: 'var(--text-muted)' }} />
            {showTip && (
              <div
                className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-52 rounded-lg px-3 py-1.5 text-[11px] font-medium pointer-events-none z-50 shadow-lg"
                style={{ background: 'var(--card-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' }}
              >
                {tooltip}
                <div
                  className="absolute top-full left-1/2 -translate-x-1/2 -mt-px h-0 w-0"
                  style={{ borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '5px solid var(--border-strong)' }}
                />
              </div>
            )}
          </div>
        )}
      </div>
      <div className="mt-1 text-[22px] font-bold" style={{ color }}>{value ?? count ?? 0}</div>
    </div>
  )
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={cn('px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide', className)} style={{ color: 'var(--text-muted)' }}>
      {children}
    </th>
  )
}

function ThSortable({ children, field, current, dir, onSort }: {
  children: React.ReactNode
  field: SortField
  current: SortField
  dir: SortDir
  onSort: (f: SortField) => void
}) {
  const active = current === field
  return (
    <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
      <button onClick={() => onSort(field)} className="flex items-center gap-1 transition-colors hover:text-zinc-300">
        {children}
        <ArrowUpDown
          className={cn('h-3 w-3', active ? 'text-zinc-300' : 'text-zinc-600')}
          style={active && dir === 'asc' ? { transform: 'scaleY(-1)' } : undefined}
        />
      </button>
    </th>
  )
}

function BreachRow({ breach, showEmail, onAcknowledge, t }: {
  breach: FlatBreach
  showEmail: boolean
  onAcknowledge: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const isNew = !breach.acknowledgedAt
  const isSensitive = breach.isSensitive

  return (
    <tr className="border-t transition-colors hover:bg-white/[0.02]" style={{ borderColor: 'var(--border-subtle)' }}>
      {/* Breach name */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-zinc-200">
            {isSensitive ? t('table.sensitive') : breach.title}
          </span>
          {breach.isVerified && (
            <span className="text-[10px] font-medium" style={{ color: '#60a5fa' }}>{t('table.verified')}</span>
          )}
        </div>
        {!isSensitive && breach.domain && (
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{breach.domain}</div>
        )}
      </td>

      {/* Email */}
      {showEmail && (
        <td className="px-4 py-3">
          <span className="text-[12px] text-zinc-500">{breach.email}</span>
        </td>
      )}

      {/* Date */}
      <td className="px-4 py-3">
        <span className="text-[12px] text-zinc-400">{breach.breachDate ? formatDate(breach.breachDate) : '—'}</span>
      </td>

      {/* Accounts */}
      <td className="px-4 py-3">
        <span className="text-[12px] text-zinc-400">{breach.pwnCount > 0 ? formatCount(breach.pwnCount) : '—'}</span>
      </td>

      {/* Data classes */}
      <td className="px-4 py-3">
        {!isSensitive && breach.dataClasses.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {breach.dataClasses.slice(0, 3).map((dc) => (
              <span key={dc} className="rounded px-1.5 py-0.5 text-[10px]"
                style={{ background: 'rgba(239,68,68,0.08)', color: '#f87171', border: '1px solid rgba(239,68,68,0.12)' }}>
                {dc}
              </span>
            ))}
            {breach.dataClasses.length > 3 && (
              <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                +{breach.dataClasses.length - 3}
              </span>
            )}
          </div>
        ) : (
          <span className="text-[12px] text-zinc-600">—</span>
        )}
      </td>

      {/* Status */}
      <td className="px-4 py-3">
        {isNew ? (
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold"
            style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}>
            {t('table.new')}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
            style={{ background: 'rgba(113,113,122,0.12)', color: '#71717a' }}>
            {t('table.reviewed')}
          </span>
        )}
      </td>

      {/* Action */}
      <td className="px-4 py-3">
        {isNew && (
          <button
            onClick={onAcknowledge}
            className="rounded-lg p-1.5 transition-colors text-zinc-500 hover:text-zinc-200 hover:bg-white/5"
            title={t('actions.acknowledgeTooltip')}
          >
            <Check className="h-4 w-4" />
          </button>
        )}
      </td>
    </tr>
  )
}
