import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CalendarClock, Plus, Clock, CheckCircle2, XCircle, Minus,
  Pencil, Trash2, Copy, Sparkles, Database, Globe, AppWindow,
  Gamepad2, Trash, Monitor, Download, Zap, AlertTriangle, X
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useSettingsStore } from '@/stores/settings-store'
import { usePlatform } from '@/hooks/usePlatform'
import type { ScheduleEntry, ScheduleTaskType } from '@shared/types'
import { getNextRunTime } from './schedules-utils'

// ─── Constants ────────────────────────────────────────────

const DAY_NAME_KEYS = ['dayNames.sunday', 'dayNames.monday', 'dayNames.tuesday', 'dayNames.wednesday', 'dayNames.thursday', 'dayNames.friday', 'dayNames.saturday']

const MAX_SCHEDULES = 10

interface TaskDef {
  type: ScheduleTaskType
  label: string
  icon: typeof Sparkles
  group: 'cleaner' | 'maintenance'
  /** Platform feature flag — task is hidden when this feature is false */
  requiresFeature?: 'registry' | 'drivers'
}

const ALL_TASKS_BASE: Array<Omit<TaskDef, 'label'> & { labelKey: string }> = [
  { type: 'cleaner:system', labelKey: 'tasks.system', icon: Monitor, group: 'cleaner' },
  { type: 'cleaner:browsers', labelKey: 'tasks.browsers', icon: Globe, group: 'cleaner' },
  { type: 'cleaner:apps', labelKey: 'tasks.applications', icon: AppWindow, group: 'cleaner' },
  { type: 'cleaner:gaming', labelKey: 'tasks.gaming', icon: Gamepad2, group: 'cleaner' },
  { type: 'cleaner:recycleBin', labelKey: 'tasks.recycleBin', icon: Trash, group: 'cleaner' },
  { type: 'cleaner:databases', labelKey: 'tasks.databases', icon: Database, group: 'cleaner' },
  { type: 'registry', labelKey: 'tasks.registryFixes', icon: Zap, group: 'maintenance', requiresFeature: 'registry' },
  { type: 'drivers', labelKey: 'tasks.driverUpdates', icon: Download, group: 'maintenance', requiresFeature: 'drivers' },
  { type: 'software-update', labelKey: 'tasks.softwareUpdates', icon: Sparkles, group: 'maintenance' },
]

function useAllTasks(): TaskDef[] {
  const { t } = useTranslation('schedules')
  return useMemo(
    () => ALL_TASKS_BASE.map((task) => ({ ...task, label: t(task.labelKey) })),
    [t]
  )
}

/** Filter tasks to only those available on the current platform */
function usePlatformTasks(): TaskDef[] {
  const { features } = usePlatform()
  const allTasks = useAllTasks()
  return useMemo(
    () => allTasks.filter((task) => !task.requiresFeature || features[task.requiresFeature]),
    [allTasks, features]
  )
}

const CLEANER_TASKS = ALL_TASKS_BASE.filter((t) => t.group === 'cleaner').map((t) => t.type)

interface Preset {
  label: string
  description: string
  entry: Partial<ScheduleEntry>
}

function buildPresets(availableTasks: TaskDef[], t: (key: string) => string): Preset[] {
  const allTypes = availableTasks.map((task) => task.type)
  return [
    {
      label: t('presets.weeklyFullCleanLabel'),
      description: t('presets.weeklyFullCleanDescription'),
      entry: {
        name: t('presets.weeklyFullCleanLabel'),
        frequency: 'weekly',
        day: 1,
        hour: 9,
        tasks: [...CLEANER_TASKS],
        autoApply: true
      }
    },
    {
      label: t('presets.dailyLightSweepLabel'),
      description: t('presets.dailyLightSweepDescription'),
      entry: {
        name: t('presets.dailyLightSweepLabel'),
        frequency: 'daily',
        day: 0,
        hour: 8,
        tasks: ['cleaner:system', 'cleaner:browsers', 'cleaner:recycleBin'],
        autoApply: true
      }
    },
    {
      label: t('presets.monthlyDeepMaintenanceLabel'),
      description: t('presets.monthlyDeepMaintenanceDescription'),
      entry: {
        name: t('presets.monthlyDeepMaintenanceLabel'),
        frequency: 'monthly',
        day: 1,
        hour: 10,
        tasks: [...allTypes],
        autoApply: true
      }
    },
  ]
}

function makeBlankEntry(): Partial<ScheduleEntry> {
  return {
    name: '',
    frequency: 'weekly',
    day: 1,
    hour: 9,
    tasks: [...CLEANER_TASKS],
    autoApply: false
  }
}

// ─── Main Page ────────────────────────────────────────────

export function SchedulesPage() {
  const { t } = useTranslation('schedules')
  const { settings, updateSettings } = useSettingsStore()
  const platformTasks = usePlatformTasks()
  const allTasks = useAllTasks()
  const presets = useMemo(() => buildPresets(platformTasks, t), [platformTasks, t])
  const schedules = settings.schedules ?? []

  const save = (updated: ScheduleEntry[]) => {
    updateSettings({ schedules: updated })
    window.kudu?.settingsSet?.({ schedules: updated }).catch(() => {})
  }

  // Ensure startup + tray when any schedule is enabled
  const ensureBackgroundMode = () => {
    if (!settings.runAtStartup) {
      updateSettings({ runAtStartup: true })
      window.kudu?.settingsSet?.({ runAtStartup: true }).catch(() => {})
      window.kudu?.applyStartup?.(true).catch(() => {
        updateSettings({ runAtStartup: false })
        window.kudu?.settingsSet?.({ runAtStartup: false }).catch(() => {})
        toast.error(t('failedEnableStartup'), {
          action: {
            label: t('failedEnableStartupAction'),
            onClick: () => window.open('https://usekudu.com/help/startup-failed', '_blank'),
          },
        })
      })
    }
    if (!settings.minimizeToTray) {
      updateSettings({ minimizeToTray: true })
      window.kudu?.settingsSet?.({ minimizeToTray: true }).catch(() => {})
      window.kudu?.applyTray?.(true)
    }
  }

  const [showDialog, setShowDialog] = useState(false)
  const [showPresets, setShowPresets] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const handleNew = () => {
    if (schedules.length >= MAX_SCHEDULES) {
      toast.error(t('maxSchedulesReached', { max: MAX_SCHEDULES }))
      return
    }
    setEditingId(null)
    setShowPresets(true)
  }

  const handlePresetSelect = (preset: Partial<ScheduleEntry> | null) => {
    setShowPresets(false)
    setEditingId(null)
    setShowDialog(true)
    // The dialog will pick up the preset via initialData
    setDialogInitial(preset ?? makeBlankEntry())
  }

  const handleEdit = (id: string) => {
    const entry = schedules.find((s) => s.id === id)
    if (!entry) return
    setDialogInitial(entry)
    setEditingId(id)
    setShowDialog(true)
  }

  const handleDuplicate = (id: string) => {
    if (schedules.length >= MAX_SCHEDULES) {
      toast.error(t('maxSchedulesReached', { max: MAX_SCHEDULES }))
      return
    }
    const entry = schedules.find((s) => s.id === id)
    if (!entry) return
    const dup: ScheduleEntry = {
      ...entry,
      id: crypto.randomUUID(),
      name: `${entry.name} ${t('copyNameSuffix')}`,
      lastRunAt: null,
      lastRunStatus: 'never',
      createdAt: new Date().toISOString()
    }
    save([...schedules, dup])
    toast.success(t('duplicatedToast', { name: entry.name }))
  }

  const handleDelete = () => {
    if (!deleteId) return
    const entry = schedules.find((s) => s.id === deleteId)
    save(schedules.filter((s) => s.id !== deleteId))
    setDeleteId(null)
    if (entry) toast.success(t('deletedToast', { name: entry.name }))
  }

  const handleToggle = (id: string, enabled: boolean) => {
    save(schedules.map((s) => (s.id === id ? { ...s, enabled } : s)))
    if (enabled) ensureBackgroundMode()
  }

  const handleSave = (entry: ScheduleEntry) => {
    if (editingId) {
      save(schedules.map((s) => (s.id === editingId ? entry : s)))
    } else {
      save([...schedules, entry])
    }
    if (entry.enabled) ensureBackgroundMode()
    setShowDialog(false)
    setEditingId(null)
    toast.success(editingId ? t('updatedToast', { name: entry.name }) : t('createdToast', { name: entry.name }))
  }

  const [dialogInitial, setDialogInitial] = useState<Partial<ScheduleEntry>>(makeBlankEntry())

  return (
    <div className="animate-fade-in">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        action={
          <button
            onClick={handleNew}
            className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold transition-colors"
            style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
          >
            <Plus className="h-4 w-4" strokeWidth={2.2} />
            {t('newScheduleButton')}
          </button>
        }
      />

      {schedules.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title={t('emptyStateTitle')}
          description={t('emptyStateDescription')}
          action={
            <button
              onClick={handleNew}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-colors"
              style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
            >
              <Plus className="h-4 w-4" strokeWidth={2.2} />
              {t('createScheduleButton')}
            </button>
          }
        />
      ) : (
        <div className="space-y-3">
          {schedules.map((entry) => (
            <ScheduleCard
              key={entry.id}
              entry={entry}
              onToggle={(enabled) => handleToggle(entry.id, enabled)}
              onEdit={() => handleEdit(entry.id)}
              onDuplicate={() => handleDuplicate(entry.id)}
              onDelete={() => setDeleteId(entry.id)}
            />
          ))}
        </div>
      )}

      {/* Preset picker */}
      {showPresets && (
        <PresetPicker
          presets={presets}
          onSelect={handlePresetSelect}
          onClose={() => setShowPresets(false)}
        />
      )}

      {/* Schedule editor dialog */}
      {showDialog && (
        <ScheduleDialog
          initial={dialogInitial}
          isEditing={!!editingId}
          availableTasks={platformTasks}
          onSave={handleSave}
          onClose={() => { setShowDialog(false); setEditingId(null) }}
        />
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteId}
        onConfirm={handleDelete}
        onCancel={() => setDeleteId(null)}
        title={t('deleteConfirmTitle')}
        description={t('deleteConfirmDescription')}
        confirmLabel={t('deleteConfirmLabel')}
        variant="danger"
      />
    </div>
  )
}

// ─── Schedule Card ────────────────────────────────────────

function ScheduleCard({
  entry,
  onToggle,
  onEdit,
  onDuplicate,
  onDelete
}: {
  entry: ScheduleEntry
  onToggle: (enabled: boolean) => void
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation('schedules')
  const allTasks = useAllTasks()
  const nextRun = useMemo(() => getNextRunTime(entry), [entry])
  const frequencyText = useMemo(() => formatFrequency(entry, t), [entry, t])
  const taskCount = entry.tasks.length

  return (
    <div
      className={cn(
        'group rounded-2xl p-5 transition-all',
        !entry.enabled && 'opacity-50'
      )}
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}
    >
      {/* Top row */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <h3 className="truncate text-[15px] font-semibold text-white">{entry.name}</h3>
            {entry.autoApply && (
              <span
                className="shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                style={{ background: 'var(--accent-muted-bg)', color: 'var(--accent)' }}
              >
                {t('card.autoApplyBadge')}
              </span>
            )}
          </div>
          <p className="mt-1 text-[13px]" style={{ color: 'var(--text-muted)' }}>
            {frequencyText}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Actions — visible on hover */}
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <IconBtn icon={Pencil} title={t('card.editAction')} onClick={onEdit} />
            <IconBtn icon={Copy} title={t('card.duplicateAction')} onClick={onDuplicate} />
            <IconBtn icon={Trash2} title={t('card.deleteAction')} onClick={onDelete} color="#ef4444" />
          </div>

          <Toggle checked={entry.enabled} onChange={onToggle} />
        </div>
      </div>

      {/* Task pills */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {entry.tasks.map((taskType) => {
          const def = allTasks.find((d) => d.type === taskType)
          if (!def) return null
          return (
            <span
              key={taskType}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium"
              style={{ background: 'var(--bg-subtle-2)', color: 'var(--text-muted)' }}
            >
              <def.icon className="h-3 w-3" strokeWidth={1.8} />
              {def.label}
            </span>
          )
        })}
        {taskCount === 0 && (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{t('card.noTasksSelected')}</span>
        )}
      </div>

      {/* Bottom row */}
      <div className="mt-4 flex items-center gap-5" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
        {/* Next run */}
        {entry.enabled && nextRun && (
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent)' }} strokeWidth={1.8} />
            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              {t('card.nextRun', { time: formatNextRun(nextRun, t) })}
            </span>
          </div>
        )}

        {/* Last run */}
        <div className="flex items-center gap-2">
          {entry.lastRunStatus === 'success' && (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" style={{ color: '#22c55e' }} strokeWidth={1.8} />
          )}
          {entry.lastRunStatus === 'partial' && (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" style={{ color: '#eab308' }} strokeWidth={1.8} />
          )}
          {entry.lastRunStatus === 'failed' && (
            <XCircle className="h-3.5 w-3.5 shrink-0" style={{ color: '#ef4444' }} strokeWidth={1.8} />
          )}
          {entry.lastRunStatus === 'never' && (
            <Minus className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-faint)' }} strokeWidth={1.8} />
          )}
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {entry.lastRunAt ? t('card.lastRun', { time: formatLastRun(entry.lastRunAt, t) }) : t('card.neverRun')}
          </span>
        </div>
      </div>
    </div>
  )
}

// ─── Preset Picker Dialog ─────────────────────────────────

function PresetPicker({
  presets,
  onSelect,
  onClose
}: {
  presets: Preset[]
  onSelect: (preset: Partial<ScheduleEntry> | null) => void
  onClose: () => void
}) {
  const { t } = useTranslation('schedules')
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }} onClick={onClose} />
      <div
        className="relative w-full max-w-md animate-scale-in rounded-2xl p-6"
        style={{ background: 'var(--card-bg)', border: '1px solid var(--border-medium)', boxShadow: '0 24px 80px rgba(0,0,0,0.5)' }}
      >
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-[16px] font-semibold text-white">{t('presets.dialogTitle')}</h3>
          <button onClick={onClose} className="text-zinc-600 transition-colors hover:text-zinc-400">
            <X className="h-5 w-5" strokeWidth={1.8} />
          </button>
        </div>

        <div className="space-y-2.5">
          {presets.map((preset) => (
            <button
              key={preset.label}
              onClick={() => onSelect(preset.entry)}
              className="w-full rounded-xl p-4 text-left transition-colors"
              style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-default)' }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(245,158,11,0.3)' }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
            >
              <p className="text-[14px] font-medium text-zinc-200">{preset.label}</p>
              <p className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>{preset.description}</p>
            </button>
          ))}

          <button
            onClick={() => onSelect(null)}
            className="w-full rounded-xl p-4 text-left transition-colors"
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-default)' }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(245,158,11,0.3)' }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
          >
            <p className="text-[14px] font-medium text-zinc-200">{t('presets.customLabel')}</p>
            <p className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>{t('presets.customDescription')}</p>
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Schedule Editor Dialog ───────────────────────────────

function ScheduleDialog({
  initial,
  isEditing,
  availableTasks,
  onSave,
  onClose
}: {
  initial: Partial<ScheduleEntry>
  isEditing: boolean
  availableTasks: TaskDef[]
  onSave: (entry: ScheduleEntry) => void
  onClose: () => void
}) {
  const { t } = useTranslation('schedules')
  const [name, setName] = useState(initial.name ?? '')
  const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'monthly'>(initial.frequency ?? 'weekly')
  const [day, setDay] = useState(initial.day ?? 1)
  const [hour, setHour] = useState(initial.hour ?? 9)
  const [tasks, setTasks] = useState<ScheduleTaskType[]>(initial.tasks ?? [...CLEANER_TASKS])
  const [autoApply, setAutoApply] = useState(initial.autoApply ?? false)

  const toggleTask = (type: ScheduleTaskType) => {
    setTasks((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    )
  }

  const allAvailableTypes = availableTasks.map((t) => t.type)
  const selectAll = () => setTasks([...allAvailableTypes])
  const deselectAll = () => setTasks([])

  const canSave = name.trim().length > 0 && tasks.length > 0

  const handleSubmit = () => {
    if (!canSave) return
    const entry: ScheduleEntry = {
      id: (initial as ScheduleEntry).id ?? crypto.randomUUID(),
      name: name.trim(),
      enabled: (initial as ScheduleEntry).enabled ?? true,
      frequency,
      day,
      hour,
      tasks,
      autoApply,
      lastRunAt: (initial as ScheduleEntry).lastRunAt ?? null,
      lastRunStatus: (initial as ScheduleEntry).lastRunStatus ?? 'never',
      createdAt: (initial as ScheduleEntry).createdAt ?? new Date().toISOString()
    }
    onSave(entry)
  }

  const selectStyle = "rounded-lg px-3 py-1.5 text-[13px] text-zinc-400 outline-none"
  const selectBorder = { background: 'var(--bg-subtle-2)', border: '1px solid var(--border-medium)' }

  const cleanerTasks = availableTasks.filter((t) => t.group === 'cleaner')
  const maintTasks = availableTasks.filter((t) => t.group === 'maintenance')

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }} onClick={onClose} />
      <div
        className="relative max-h-[85vh] w-full max-w-lg animate-scale-in overflow-y-auto rounded-2xl p-6"
        style={{ background: 'var(--card-bg)', border: '1px solid var(--border-medium)', boxShadow: '0 24px 80px rgba(0,0,0,0.5)' }}
      >
        <div className="mb-6 flex items-center justify-between">
          <h3 className="text-[16px] font-semibold text-white">
            {isEditing ? t('dialog.editTitle') : t('dialog.newTitle')}
          </h3>
          <button onClick={onClose} className="text-zinc-600 transition-colors hover:text-zinc-400">
            <X className="h-5 w-5" strokeWidth={1.8} />
          </button>
        </div>

        {/* Name */}
        <div className="mb-5">
          <label className="mb-1.5 block text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>{t('dialog.nameLabel')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('dialog.namePlaceholder')}
            maxLength={60}
            className="w-full rounded-xl px-4 py-2.5 text-[13px] text-zinc-300 outline-none placeholder:text-zinc-700"
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-medium)' }}
          />
        </div>

        {/* Schedule timing */}
        <div className="mb-5 grid grid-cols-3 gap-3">
          <div>
            <label className="mb-1.5 block text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>{t('dialog.frequencyLabel')}</label>
            <select
              value={frequency}
              onChange={(e) => {
                const f = e.target.value as 'daily' | 'weekly' | 'monthly'
                setFrequency(f)
                // Reset day to a sensible default for the new frequency
                if (f === 'weekly') setDay(1) // Monday
                if (f === 'monthly') setDay(1) // 1st
              }}
              className={cn(selectStyle, 'w-full')}
              style={selectBorder}
            >
              <option value="daily">{t('dialog.frequencyDaily')}</option>
              <option value="weekly">{t('dialog.frequencyWeekly')}</option>
              <option value="monthly">{t('dialog.frequencyMonthly')}</option>
            </select>
          </div>

          {frequency === 'weekly' && (
            <div>
              <label className="mb-1.5 block text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>{t('dialog.dayLabel')}</label>
              <select
                value={day}
                onChange={(e) => setDay(Number(e.target.value))}
                className={cn(selectStyle, 'w-full')}
                style={selectBorder}
              >
                {DAY_NAME_KEYS.map((key, i) => <option key={i} value={i}>{t(key)}</option>)}
              </select>
            </div>
          )}

          {frequency === 'monthly' && (
            <div>
              <label className="mb-1.5 block text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>{t('dialog.dayLabel')}</label>
              <select
                value={day}
                onChange={(e) => setDay(Number(e.target.value))}
                className={cn(selectStyle, 'w-full')}
                style={selectBorder}
              >
                {Array.from({ length: 31 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>{ordinal(i + 1)}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>{t('dialog.timeLabel')}</label>
            <select
              value={hour}
              onChange={(e) => setHour(Number(e.target.value))}
              className={cn(selectStyle, 'w-full')}
              style={selectBorder}
            >
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>
              ))}
            </select>
          </div>
        </div>

        {/* Tasks */}
        <div className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <label className="text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>{t('dialog.tasksLabel')}</label>
            <div className="flex gap-3">
              <button onClick={selectAll} className="text-[11px] font-medium" style={{ color: 'var(--accent)' }}>{t('dialog.selectAll')}</button>
              <button onClick={deselectAll} className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{t('dialog.deselectAll')}</button>
            </div>
          </div>

          <div
            className="rounded-xl p-4"
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-default)' }}
          >
            {/* Cleaner group */}
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>{t('dialog.cleanerGroup')}</p>
            <div className="mb-4 grid grid-cols-2 gap-1.5">
              {cleanerTasks.map((task) => (
                <TaskCheckbox
                  key={task.type}
                  task={task}
                  checked={tasks.includes(task.type)}
                  onChange={() => toggleTask(task.type)}
                />
              ))}
            </div>

            {/* Maintenance group */}
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>{t('dialog.maintenanceGroup')}</p>
            <div className="grid grid-cols-2 gap-1.5">
              {maintTasks.map((task) => (
                <TaskCheckbox
                  key={task.type}
                  task={task}
                  checked={tasks.includes(task.type)}
                  onChange={() => toggleTask(task.type)}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Auto-apply */}
        <div
          className="mb-6 flex items-start gap-4 rounded-xl p-4"
          style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-default)' }}
        >
          <div className="flex-1">
            <p className="text-[13px] font-medium text-zinc-300">{t('dialog.autoApplyLabel')}</p>
            <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {t('dialog.autoApplyDescription')}
            </p>
          </div>
          <Toggle checked={autoApply} onChange={setAutoApply} />
        </div>

        {autoApply && (
          <div
            className="mb-6 flex items-start gap-3 rounded-xl p-3"
            style={{ background: 'var(--accent-muted-bg)', border: '1px solid rgba(245,158,11,0.12)' }}
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} strokeWidth={1.8} />
            <p className="text-[12px] leading-relaxed" style={{ color: '#d97706' }}>
              {t('dialog.autoApplyWarning')}
            </p>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2.5">
          <button
            onClick={onClose}
            className="rounded-xl px-5 py-2.5 text-[13px] font-medium transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-subtle-2)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            {t('dialog.cancelButton')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSave}
            className={cn(
              'rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-colors',
              !canSave && 'cursor-not-allowed opacity-40'
            )}
            style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
          >
            {isEditing ? t('dialog.saveChangesButton') : t('dialog.createScheduleButton')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Small Components ─────────────────────────────────────

function TaskCheckbox({ task, checked, onChange }: { task: TaskDef; checked: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[12px] font-medium transition-all',
        checked ? 'text-zinc-200' : 'text-zinc-600'
      )}
      style={{
        background: checked ? 'var(--accent-muted-bg)' : 'transparent',
        border: checked ? '1px solid var(--accent-muted-border)' : '1px solid transparent'
      }}
    >
      <div
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded"
        style={{
          background: checked ? 'var(--accent)' : 'var(--bg-hover-2)',
          border: checked ? 'none' : '1px solid var(--border-stronger)'
        }}
      >
        {checked && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 5L4.2 7.5L8 2.5" stroke="var(--text-on-accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      <task.icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
      {task.label}
    </button>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onChange(!checked) }}
      className="relative h-[26px] w-[46px] shrink-0 rounded-full transition-colors"
      style={{ background: checked ? 'var(--accent)' : 'var(--bg-active)' }}
    >
      <div
        className={cn(
          'absolute top-[3px] h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
          checked ? 'translate-x-[22px]' : 'translate-x-[3px]'
        )}
      />
    </button>
  )
}

function IconBtn({ icon: Icon, title, onClick, color }: { icon: typeof Pencil; title: string; onClick: () => void; color?: string }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      title={title}
      className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
      style={{ color: color ?? 'var(--text-muted)' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover-2)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      <Icon className="h-4 w-4" strokeWidth={1.8} />
    </button>
  )
}

// ─── Utilities ────────────────────────────────────────────

function formatFrequency(entry: ScheduleEntry, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const time = `${String(entry.hour).padStart(2, '0')}:00`
  switch (entry.frequency) {
    case 'daily':
      return t('frequency.everyDayAt', { time })
    case 'weekly':
      return t('frequency.everyWeekdayAt', { day: t(DAY_NAME_KEYS[entry.day] ?? 'dayNames.monday'), time })
    case 'monthly':
      return t('frequency.monthlyAt', { ordinalDay: ordinal(entry.day), time })
  }
}

function formatNextRun(date: Date, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffD = Math.floor(diffMs / 86_400_000)
  const time = `${String(date.getHours()).padStart(2, '0')}:00`

  if (diffD === 0 && date.getDate() === now.getDate()) return t('nextRun.todayAt', { time })
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (date.getFullYear() === tomorrow.getFullYear() && date.getMonth() === tomorrow.getMonth() && date.getDate() === tomorrow.getDate()) return t('nextRun.tomorrowAt', { time })
  if (diffD < 7) return t('nextRun.inDaysAt', { count: diffD, time })
  return t('nextRun.dateAt', { date: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), time })
}

function formatLastRun(iso: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const date = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffM = Math.floor(diffMs / 60_000)
  const diffH = Math.floor(diffMs / 3_600_000)
  const diffD = Math.floor(diffMs / 86_400_000)

  if (diffM < 1) return t('lastRun.justNow')
  if (diffM < 60) return t('lastRun.minutesAgo', { count: diffM })
  if (diffH < 24) return t('lastRun.hoursAgo', { count: diffH })
  if (diffD < 7) return t('lastRun.daysAgo', { count: diffD })
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
