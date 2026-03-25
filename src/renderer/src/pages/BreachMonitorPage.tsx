import { useEffect, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  ChevronDown,
  AlertTriangle,
  Mail,
  Plus,
  X,
  Lock,
  CheckCircle,
  XCircle,
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
  const expandedEmail = useBreachStore((s) => s.expandedEmail)
  const addingEmail = useBreachStore((s) => s.addingEmail)
  const fetchBreaches = useBreachStore((s) => s.fetch)
  const addEmail = useBreachStore((s) => s.addEmail)
  const removeEmail = useBreachStore((s) => s.removeEmail)
  const setExpandedEmail = useBreachStore((s) => s.setExpandedEmail)

  const [emailInput, setEmailInput] = useState('')

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

  // Toast on error — skip "not connected" (silent retry), 403 (inline upgrade prompt),
  // and errors when there are no emails (nothing to fail on — just show empty state)
  useEffect(() => {
    if (error && !error.includes('not connected') && !error.includes('403') && emails.length > 0) {
      toast.error(t('toast.fetchFailed'))
    }
  }, [error, emails.length, t])

  const handleRefresh = useCallback(() => {
    fetchBreaches()
  }, [fetchBreaches])

  const handleAddEmail = useCallback(async () => {
    const value = emailInput.trim().toLowerCase()
    if (!value) return
    if (!EMAIL_RE.test(value)) {
      toast.error(t('toast.invalidEmail'))
      return
    }
    if (usage >= limit && limit > 0) {
      toast.error(t('toast.limitReached'))
      return
    }
    try {
      await addEmail(value)
      setEmailInput('')
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      if (msg.includes('422')) {
        toast.error(t('toast.limitReached'))
      } else if (msg.includes('403')) {
        toast.error(t('toast.limitReached'))
      } else {
        toast.error(t('toast.addFailed'))
      }
    }
  }, [emailInput, usage, limit, addEmail, t])

  const handleRemoveEmail = useCallback(async (email: string) => {
    try {
      await removeEmail(email)
    } catch {
      toast.error(t('toast.removeFailed'))
    }
  }, [removeEmail, t])

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
  const totalBreaches = emails.reduce((sum, e) => sum + e.breaches.length, 0)

  return (
    <div className="p-8 animate-fade-in max-w-4xl">
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

      {/* Main content (no 403 error) */}
      {!is403 && (
        <>
          {/* Generic error banner — only show if the user has emails (otherwise there's nothing to "fail") */}
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
          <div className="mb-6 grid grid-cols-2 gap-3">
            <SummaryCard
              label={t('summary.totalBreaches')}
              count={totalBreaches}
              color={totalBreaches > 0 ? '#ef4444' : '#22c55e'}
            />
            <SummaryCard
              label={t('summary.emailsMonitored')}
              value={`${usage} / ${limit}`}
              color="#a1a1aa"
            />
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
                  ? 'var(--bg-subtle-2)'
                  : 'linear-gradient(135deg, #fbbf24, #f59e0b)',
                border: '1px solid var(--border-medium)',
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              {addingEmail ? t('addEmail.adding') : t('addEmail.button')}
            </button>
          </div>

          {/* No emails yet */}
          {emails.length === 0 && status === 'done' && (
            <EmptyState
              icon={Mail}
              title={t('emptyState.noEmails')}
              description={t('emptyState.noEmailsDesc')}
            />
          )}

          {/* Emails exist but no breaches */}
          {emails.length > 0 && totalBreaches === 0 && status === 'done' && (
            <EmptyState
              icon={ShieldCheck}
              title={t('emptyState.allClear')}
              description={t('emptyState.allClearDesc')}
              className="pb-8 pt-8"
            />
          )}

          {/* Email list */}
          {emails.length > 0 && (
            <div className="space-y-3">
              {emails.map((monitored) => (
                <EmailCard
                  key={monitored.email}
                  monitored={monitored}
                  expanded={expandedEmail === monitored.email}
                  onToggle={() =>
                    setExpandedEmail(expandedEmail === monitored.email ? null : monitored.email)
                  }
                  onRemove={() => handleRemoveEmail(monitored.email)}
                  t={t}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SummaryCard({ label, count, value, color }: { label: string; count?: number; value?: string; color: string }) {
  return (
    <div
      className="rounded-xl px-4 py-3"
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}
    >
      <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {label}
      </div>
      <div className="mt-1 text-[22px] font-bold" style={{ color }}>
        {value ?? count ?? 0}
      </div>
    </div>
  )
}

function EmailCard({
  monitored,
  expanded,
  onToggle,
  onRemove,
  t,
}: {
  monitored: MonitoredEmail
  expanded: boolean
  onToggle: () => void
  onRemove: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const breachCount = monitored.breaches.length
  const hasBreach = breachCount > 0

  const sortedBreaches = [...monitored.breaches].sort(
    (a, b) => new Date(b.breachDate).getTime() - new Date(a.breachDate).getTime()
  )

  return (
    <div
      className="rounded-xl transition-colors"
      style={{
        background: hasBreach ? 'rgba(239,68,68,0.05)' : 'var(--card-bg)',
        border: `1px solid ${hasBreach ? 'rgba(239,68,68,0.15)' : 'var(--border-default)'}`,
      }}
    >
      {/* Header */}
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
      >
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform', expanded && 'rotate-180')}
        />

        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--bg-subtle)' }}>
          <Mail className="h-4 w-4" style={{ color: hasBreach ? '#ef4444' : 'var(--text-muted)' }} strokeWidth={1.7} />
        </div>

        <div className="min-w-0 flex-1">
          <span className="text-[13px] font-medium text-zinc-200">{monitored.email}</span>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {monitored.lastCheckedAt
                ? t('emailCard.lastChecked', { date: formatDate(monitored.lastCheckedAt) })
                : t('emailCard.notCheckedYet')
              }
            </span>
            {monitored.fresh && (
              <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: 'rgba(34,197,94,0.12)', color: '#22c55e' }}>
                {t('emailCard.fresh')}
              </span>
            )}
            {monitored.monitoringPaused && (
              <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: 'rgba(245,158,11,0.12)', color: '#fbbf24' }}>
                {t('emailCard.paused')}
              </span>
            )}
          </div>
        </div>

        {/* Breach count badge */}
        {hasBreach ? (
          <span
            className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold"
            style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}
          >
            <ShieldAlert className="h-3 w-3" />
            {breachCount}
          </span>
        ) : (
          <span
            className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium"
            style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}
          >
            <ShieldCheck className="h-3 w-3" />
            {t('emailCard.noBreaches')}
          </span>
        )}

        {/* Remove button */}
        <button
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          className="rounded-lg p-1.5 transition-colors"
          style={{ color: 'var(--text-muted)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          title={t('emailCard.remove')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </button>

      {/* Expanded breach list */}
      {expanded && sortedBreaches.length > 0 && (
        <div className="border-t px-4 pb-4 pt-3 space-y-2" style={{ borderColor: hasBreach ? 'rgba(239,68,68,0.15)' : 'var(--border-default)' }}>
          {sortedBreaches.map((breach) => (
            <BreachCard key={breach.name} breach={breach} t={t} />
          ))}
        </div>
      )}

      {expanded && sortedBreaches.length === 0 && (
        <div className="border-t px-4 py-6 text-center" style={{ borderColor: 'var(--border-default)' }}>
          <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>{t('emailCard.noBreaches')}</p>
        </div>
      )}
    </div>
  )
}

function BreachCard({
  breach,
  t,
}: {
  breach: BreachEntry
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  return (
    <div
      className="rounded-lg px-4 py-3"
      style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-zinc-200">
              {breach.isSensitive ? t('breachCard.sensitiveBreach') : breach.title}
            </span>
            {breach.isVerified ? (
              <span className="flex items-center gap-0.5 text-[10px] font-medium" style={{ color: '#60a5fa' }}>
                <CheckCircle className="h-3 w-3" />
                {t('breachCard.verified')}
              </span>
            ) : (
              <span className="flex items-center gap-0.5 text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
                <XCircle className="h-3 w-3" />
                {t('breachCard.unverified')}
              </span>
            )}
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {!breach.isSensitive && breach.domain && (
              <span>{breach.domain}</span>
            )}
            {breach.breachDate && (
              <span>{t('breachCard.breachDate', { date: formatDate(breach.breachDate) })}</span>
            )}
            {breach.pwnCount > 0 && (
              <span>{t('breachCard.affectedAccounts', { count: formatCount(breach.pwnCount) })}</span>
            )}
          </div>
        </div>
      </div>

      {/* Data classes */}
      {breach.dataClasses.length > 0 && !breach.isSensitive && (
        <div className="mt-2.5">
          <div className="text-[10px] font-medium uppercase tracking-wide mb-1.5" style={{ color: 'var(--text-muted)' }}>
            {t('breachCard.compromisedData')}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {breach.dataClasses.map((dc) => (
              <span
                key={dc}
                className="rounded-md px-2 py-0.5 text-[11px]"
                style={{ background: 'rgba(239,68,68,0.08)', color: '#f87171', border: '1px solid rgba(239,68,68,0.12)' }}
              >
                {dc}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
