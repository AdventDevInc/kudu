import { useEffect, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  AlertTriangle,
  Mail,
  Plus,
  X,
  Lock,
  Check,
  CheckCheck,
  ArrowUpDown,
  Inbox,
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { cn } from '@/lib/utils'
import { useBreachStore } from '@/stores/breach-store'
import { useSettingsStore } from '@/stores/settings-store'
import type { MonitoredEmail, BreachEntry } from '@shared/types'

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
  const selectedEmail = useBreachStore((s) => s.selectedEmail)
  const addingEmail = useBreachStore((s) => s.addingEmail)
  const fetchBreaches = useBreachStore((s) => s.fetch)
  const addEmail = useBreachStore((s) => s.addEmail)
  const removeEmail = useBreachStore((s) => s.removeEmail)
  const acknowledgeBreaches = useBreachStore((s) => s.acknowledgeBreaches)
  const setSelectedEmail = useBreachStore((s) => s.setSelectedEmail)

  const [emailInput, setEmailInput] = useState('')
  const [sortField, setSortField] = useState<SortField>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  // Auto-fetch on mount
  useEffect(() => {
    if (!isLinked) return
    if (status === 'idle') {
      fetchBreaches()
      return
    }
    if (status === 'done' && error?.includes('not connected')) {
      const timer = setTimeout(() => fetchBreaches(), 3000)
      return () => clearTimeout(timer)
    }
  }, [isLinked, status, error, fetchBreaches])

  // Auto-select first email when emails load and none is selected
  useEffect(() => {
    if (emails.length > 0 && !selectedEmail) {
      setSelectedEmail(emails[0].email)
    }
  }, [emails, selectedEmail, setSelectedEmail])

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
    try { await removeEmail(email) } catch { toast.error(t('toast.removeFailed')) }
  }, [removeEmail, t])

  const handleAcknowledge = useCallback(async (breachIds: string[]) => {
    try {
      await acknowledgeBreaches(breachIds)
      toast.success(t('toast.acknowledged'))
    } catch { toast.error(t('toast.acknowledgeFailed')) }
  }, [acknowledgeBreaches, t])

  const toggleSort = useCallback((field: SortField) => {
    if (sortField === field) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('desc') }
  }, [sortField])

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
  const allBreaches = emails.flatMap((e) => e.breaches)
  const totalBreaches = allBreaches.length
  const unacknowledgedCount = allBreaches.filter((b) => !b.acknowledgedAt).length
  const currentEmail = emails.find((e) => e.email === selectedEmail)

  // Sort breaches for the selected email
  const sortedBreaches = currentEmail
    ? [...currentEmail.breaches].sort((a, b) => {
        const dir = sortDir === 'asc' ? 1 : -1
        if (sortField === 'date') return dir * (new Date(a.breachDate).getTime() - new Date(b.breachDate).getTime())
        if (sortField === 'accounts') return dir * (a.pwnCount - b.pwnCount)
        // status: unacknowledged first
        const aAck = a.acknowledgedAt ? 1 : 0
        const bAck = b.acknowledgedAt ? 1 : 0
        return dir * (aAck - bAck)
      })
    : []

  const unacknowledgedForEmail = currentEmail
    ? currentEmail.breaches.filter((b) => !b.acknowledgedAt).map((b) => b.name)
    : []

  return (
    <div className="p-8 animate-fade-in max-w-5xl">
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
              onClick={() => navigate('/cloud')}
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
            <SummaryCard label={t('summary.emailsMonitored')} value={`${usage} / ${limit}`} color="#a1a1aa" />
          </div>

          {/* Add email input */}
          <div className="mb-6 flex items-center gap-2.5">
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
                  ? 'cursor-not-allowed opacity-50 text-zinc-500'
                  : 'text-black'
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

          {/* Main layout: email list + breach table */}
          {emails.length > 0 && (
            <div className="flex gap-4" style={{ minHeight: 300 }}>
              {/* Email sidebar list */}
              <div
                className="w-64 shrink-0 rounded-xl overflow-hidden"
                style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}
              >
                {emails.map((em) => {
                  const breachCount = em.breaches.length
                  const unack = em.breaches.filter((b) => !b.acknowledgedAt).length
                  const isSelected = selectedEmail === em.email
                  return (
                    <button
                      key={em.email}
                      onClick={() => setSelectedEmail(em.email)}
                      className={cn(
                        'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors border-b',
                        isSelected ? 'text-white' : 'text-zinc-400 hover:bg-white/[0.03]'
                      )}
                      style={{
                        borderColor: 'var(--border-subtle)',
                        background: isSelected ? 'var(--accent-muted-bg)' : undefined,
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium">{em.email}</div>
                        <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          {em.lastCheckedAt
                            ? t('emailList.lastChecked', { date: formatDate(em.lastCheckedAt) })
                            : em.monitoringPaused
                              ? t('emailList.paused')
                              : t('emailList.checking')
                          }
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {breachCount > 0 ? (
                          <>
                            <span
                              className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold"
                              style={{
                                background: unack > 0 ? 'rgba(245,158,11,0.15)' : 'rgba(113,113,122,0.15)',
                                color: unack > 0 ? '#fbbf24' : '#71717a',
                              }}
                            >
                              {unack > 0 && <ShieldAlert className="h-2.5 w-2.5" />}
                              {breachCount}
                            </span>
                          </>
                        ) : (
                          <ShieldCheck className="h-3.5 w-3.5" style={{ color: '#22c55e' }} />
                        )}
                      </div>
                    </button>
                  )
                })}
                {/* Remove button at bottom of selected email */}
                {currentEmail && (
                  <button
                    onClick={() => handleRemoveEmail(currentEmail.email)}
                    className="flex w-full items-center justify-center gap-1.5 px-4 py-2.5 text-[11px] font-medium transition-colors"
                    style={{ color: 'var(--text-muted)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = '#ef4444' }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)' }}
                  >
                    <X className="h-3 w-3" />
                    {t('emailList.remove')}
                  </button>
                )}
              </div>

              {/* Breach table */}
              <div className="flex-1 min-w-0">
                {!currentEmail && (
                  <EmptyState icon={Inbox} title={t('emptyState.selectEmail')} description="" className="py-16" />
                )}

                {currentEmail && currentEmail.breaches.length === 0 && (
                  <EmptyState
                    icon={ShieldCheck}
                    title={currentEmail.lastCheckedAt ? t('emptyState.noBreachesForEmail') : t('emailList.checking')}
                    description=""
                    className="py-16"
                  />
                )}

                {currentEmail && currentEmail.breaches.length > 0 && (
                  <>
                    {/* Acknowledge all button */}
                    {unacknowledgedForEmail.length > 0 && (
                      <div className="mb-3 flex justify-end">
                        <button
                          onClick={() => handleAcknowledge(unacknowledgedForEmail)}
                          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
                          title={t('actions.acknowledgeAllTooltip')}
                        >
                          <CheckCheck className="h-3.5 w-3.5" />
                          {t('actions.acknowledgeAll')} ({unacknowledgedForEmail.length})
                        </button>
                      </div>
                    )}

                    {/* Table */}
                    <div
                      className="rounded-xl overflow-hidden"
                      style={{ border: '1px solid var(--border-default)' }}
                    >
                      <table className="w-full">
                        <thead>
                          <tr style={{ background: 'var(--bg-subtle)' }}>
                            <Th>{t('table.breach')}</Th>
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
                          {sortedBreaches.map((breach) => (
                            <BreachRow
                              key={breach.name}
                              breach={breach}
                              onAcknowledge={() => handleAcknowledge([breach.name])}
                              t={t}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Table components ────────────────────────────────────

function SummaryCard({ label, count, value, color }: { label: string; count?: number; value?: string; color: string }) {
  return (
    <div className="rounded-xl px-4 py-3" style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}>
      <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{label}</div>
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
      <button
        onClick={() => onSort(field)}
        className="flex items-center gap-1 transition-colors hover:text-zinc-300"
      >
        {children}
        <ArrowUpDown
          className={cn('h-3 w-3', active ? 'text-zinc-300' : 'text-zinc-600')}
          style={active && dir === 'asc' ? { transform: 'scaleY(-1)' } : undefined}
        />
      </button>
    </th>
  )
}

function BreachRow({ breach, onAcknowledge, t }: {
  breach: BreachEntry
  onAcknowledge: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const isNew = !breach.acknowledgedAt
  const isSensitive = breach.isSensitive

  return (
    <tr
      className="border-t transition-colors hover:bg-white/[0.02]"
      style={{ borderColor: 'var(--border-subtle)' }}
    >
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
