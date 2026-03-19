import { useState, useMemo } from 'react'
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

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const MAX_SCHEDULES = 10

interface TaskDef {
  type: ScheduleTaskType
  label: string
  icon: typeof Sparkles
  group: 'cleaner' | 'maintenance'
  /** Platform feature flag — task is hidden when this feature is false */
  requiresFeature?: 'registry' | 'drivers'
}

const ALL_TASKS: TaskDef[] = [
  { type: 'cleaner:system', label: 'System', icon: Monitor, group: 'cleaner' },
  { type: 'cleaner:browsers', label: 'Browsers', icon: Globe, group: 'cleaner' },
  { type: 'cleaner:apps', label: 'Applications', icon: AppWindow, group: 'cleaner' },
  { type: 'cleaner:gaming', label: 'Gaming', icon: Gamepad2, group: 'cleaner' },
  { type: 'cleaner:recycleBin', label: 'Recycle Bin', icon: Trash, group: 'cleaner' },
  { type: 'cleaner:databases', label: 'Databases', icon: Database, group: 'cleaner' },
  { type: 'registry', label: 'Registry Fixes', icon: Zap, group: 'maintenance', requiresFeature: 'registry' },
  { type: 'drivers', label: 'Driver Updates', icon: Download, group: 'maintenance', requiresFeature: 'drivers' },
  { type: 'software-update', label: 'Software Updates', icon: Sparkles, group: 'maintenance' },
]

/** Filter ALL_TASKS to only those available on the current platform */
function usePlatformTasks(): TaskDef[] {
  const { features } = usePlatform()
  return useMemo(
    () => ALL_TASKS.filter((t) => !t.requiresFeature || features[t.requiresFeature]),
    [features]
  )
}

const CLEANER_TASKS = ALL_TASKS.filter((t) => t.group === 'cleaner').map((t) => t.type)

interface Preset {
  label: string
  description: string
  entry: Partial<ScheduleEntry>
}

function buildPresets(availableTasks: TaskDef[]): Preset[] {
  const allTypes = availableTasks.map((t) => t.type)
  return [
    {
      label: 'Weekly Full Clean',
      description: 'All cleaner categories every Monday at 9 AM',
      entry: {
        name: 'Weekly Full Clean',
        frequency: 'weekly',
        day: 1,
        hour: 9,
        tasks: [...CLEANER_TASKS],
        autoApply: true
      }
    },
    {
      label: 'Daily Light Sweep',
      description: 'System, browsers & recycle bin daily at 8 AM',
      entry: {
        name: 'Daily Light Sweep',
        frequency: 'daily',
        day: 0,
        hour: 8,
        tasks: ['cleaner:system', 'cleaner:browsers', 'cleaner:recycleBin'],
        autoApply: true
      }
    },
    {
      label: 'Monthly Deep Maintenance',
      description: 'Full clean + registry, drivers & software on the 1st at 10 AM',
      entry: {
        name: 'Monthly Deep Maintenance',
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
  const { settings, updateSettings } = useSettingsStore()
  const platformTasks = usePlatformTasks()
  const presets = useMemo(() => buildPresets(platformTasks), [platformTasks])
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
        toast.error('Failed to enable startup. Schedules may not run after reboot.')
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
      toast.error(`Maximum of ${MAX_SCHEDULES} schedules reached.`)
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
      toast.error(`Maximum of ${MAX_SCHEDULES} schedules reached.`)
      return
    }
    const entry = schedules.find((s) => s.id === id)
    if (!entry) return
    const dup: ScheduleEntry = {
      ...entry,
      id: crypto.randomUUID(),
      name: `${entry.name} (copy)`,
      lastRunAt: null,
      lastRunStatus: 'never',
      createdAt: new Date().toISOString()
    }
    save([...schedules, dup])
    toast.success(`Duplicated "${entry.name}"`)
  }

  const handleDelete = () => {
    if (!deleteId) return
    const entry = schedules.find((s) => s.id === deleteId)
    save(schedules.filter((s) => s.id !== deleteId))
    setDeleteId(null)
    if (entry) toast.success(`Deleted "${entry.name}"`)
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
    toast.success(editingId ? `Updated "${entry.name}"` : `Created "${entry.name}"`)
  }

  const [dialogInitial, setDialogInitial] = useState<Partial<ScheduleEntry>>(makeBlankEntry())

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Schedules"
        description="Automate scans, cleanups, and updates on a schedule"
        action={
          <button
            onClick={handleNew}
            className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold transition-colors"
            style={{ background: '#f59e0b', color: '#1a0a00' }}
          >
            <Plus className="h-4 w-4" strokeWidth={2.2} />
            New Schedule
          </button>
        }
      />

      {schedules.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No schedules yet"
          description="Create a schedule to automatically run scans, cleanups, and updates."
          action={
            <button
              onClick={handleNew}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-colors"
              style={{ background: '#f59e0b', color: '#1a0a00' }}
            >
              <Plus className="h-4 w-4" strokeWidth={2.2} />
              Create Schedule
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
        title="Delete schedule"
        description="This schedule will be permanently removed. This action cannot be undone."
        confirmLabel="Delete"
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
  const nextRun = useMemo(() => getNextRunTime(entry), [entry])
  const frequencyText = useMemo(() => formatFrequency(entry), [entry])
  const taskCount = entry.tasks.length

  return (
    <div
      className={cn(
        'group rounded-2xl p-5 transition-all',
        !entry.enabled && 'opacity-50'
      )}
      style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}
    >
      {/* Top row */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <h3 className="truncate text-[15px] font-semibold text-white">{entry.name}</h3>
            {entry.autoApply && (
              <span
                className="shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                style={{ background: 'rgba(245,158,11,0.12)', color: '#f59e0b' }}
              >
                Auto-apply
              </span>
            )}
          </div>
          <p className="mt-1 text-[13px]" style={{ color: '#6e6e76' }}>
            {frequencyText}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Actions — visible on hover */}
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <IconBtn icon={Pencil} title="Edit" onClick={onEdit} />
            <IconBtn icon={Copy} title="Duplicate" onClick={onDuplicate} />
            <IconBtn icon={Trash2} title="Delete" onClick={onDelete} color="#ef4444" />
          </div>

          <Toggle checked={entry.enabled} onChange={onToggle} />
        </div>
      </div>

      {/* Task pills */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {entry.tasks.map((t) => {
          const def = ALL_TASKS.find((d) => d.type === t)
          if (!def) return null
          return (
            <span
              key={t}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium"
              style={{ background: 'rgba(255,255,255,0.04)', color: '#8e8e96' }}
            >
              <def.icon className="h-3 w-3" strokeWidth={1.8} />
              {def.label}
            </span>
          )
        })}
        {taskCount === 0 && (
          <span className="text-[11px]" style={{ color: '#52525e' }}>No tasks selected</span>
        )}
      </div>

      {/* Bottom row */}
      <div className="mt-4 flex items-center gap-5" style={{ borderTop: '1px solid rgba(255,255,255,0.04)', paddingTop: '12px' }}>
        {/* Next run */}
        {entry.enabled && nextRun && (
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 shrink-0" style={{ color: '#f59e0b' }} strokeWidth={1.8} />
            <span className="text-[12px]" style={{ color: '#8e8e96' }}>
              Next: {formatNextRun(nextRun)}
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
            <Minus className="h-3.5 w-3.5 shrink-0" style={{ color: '#3a3a42' }} strokeWidth={1.8} />
          )}
          <span className="text-[12px]" style={{ color: '#6e6e76' }}>
            {entry.lastRunAt ? `Last: ${formatLastRun(entry.lastRunAt)}` : 'Never run'}
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
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }} onClick={onClose} />
      <div
        className="relative w-full max-w-md animate-scale-in rounded-2xl p-6"
        style={{ background: '#18181c', border: '1px solid rgba(255,255,255,0.06)', boxShadow: '0 24px 80px rgba(0,0,0,0.5)' }}
      >
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-[16px] font-semibold text-white">Choose a template</h3>
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
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(245,158,11,0.3)' }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.05)' }}
            >
              <p className="text-[14px] font-medium text-zinc-200">{preset.label}</p>
              <p className="mt-1 text-[12px]" style={{ color: '#6e6e76' }}>{preset.description}</p>
            </button>
          ))}

          <button
            onClick={() => onSelect(null)}
            className="w-full rounded-xl p-4 text-left transition-colors"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(245,158,11,0.3)' }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.05)' }}
          >
            <p className="text-[14px] font-medium text-zinc-200">Custom</p>
            <p className="mt-1 text-[12px]" style={{ color: '#6e6e76' }}>Start from scratch with a blank schedule</p>
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
  const selectBorder = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }

  const cleanerTasks = availableTasks.filter((t) => t.group === 'cleaner')
  const maintTasks = availableTasks.filter((t) => t.group === 'maintenance')

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }} onClick={onClose} />
      <div
        className="relative max-h-[85vh] w-full max-w-lg animate-scale-in overflow-y-auto rounded-2xl p-6"
        style={{ background: '#18181c', border: '1px solid rgba(255,255,255,0.06)', boxShadow: '0 24px 80px rgba(0,0,0,0.5)' }}
      >
        <div className="mb-6 flex items-center justify-between">
          <h3 className="text-[16px] font-semibold text-white">
            {isEditing ? 'Edit Schedule' : 'New Schedule'}
          </h3>
          <button onClick={onClose} className="text-zinc-600 transition-colors hover:text-zinc-400">
            <X className="h-5 w-5" strokeWidth={1.8} />
          </button>
        </div>

        {/* Name */}
        <div className="mb-5">
          <label className="mb-1.5 block text-[12px] font-medium" style={{ color: '#6e6e76' }}>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Weekly Deep Clean"
            maxLength={60}
            className="w-full rounded-xl px-4 py-2.5 text-[13px] text-zinc-300 outline-none placeholder:text-zinc-700"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
          />
        </div>

        {/* Schedule timing */}
        <div className="mb-5 grid grid-cols-3 gap-3">
          <div>
            <label className="mb-1.5 block text-[12px] font-medium" style={{ color: '#6e6e76' }}>Frequency</label>
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
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>

          {frequency === 'weekly' && (
            <div>
              <label className="mb-1.5 block text-[12px] font-medium" style={{ color: '#6e6e76' }}>Day</label>
              <select
                value={day}
                onChange={(e) => setDay(Number(e.target.value))}
                className={cn(selectStyle, 'w-full')}
                style={selectBorder}
              >
                {DAY_NAMES.map((n, i) => <option key={i} value={i}>{n}</option>)}
              </select>
            </div>
          )}

          {frequency === 'monthly' && (
            <div>
              <label className="mb-1.5 block text-[12px] font-medium" style={{ color: '#6e6e76' }}>Day</label>
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
            <label className="mb-1.5 block text-[12px] font-medium" style={{ color: '#6e6e76' }}>Time</label>
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
            <label className="text-[12px] font-medium" style={{ color: '#6e6e76' }}>Tasks</label>
            <div className="flex gap-3">
              <button onClick={selectAll} className="text-[11px] font-medium" style={{ color: '#f59e0b' }}>Select all</button>
              <button onClick={deselectAll} className="text-[11px] font-medium" style={{ color: '#6e6e76' }}>Deselect all</button>
            </div>
          </div>

          <div
            className="rounded-xl p-4"
            style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}
          >
            {/* Cleaner group */}
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest" style={{ color: '#4e4e56' }}>Cleaner</p>
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
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest" style={{ color: '#4e4e56' }}>Maintenance</p>
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
          style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}
        >
          <div className="flex-1">
            <p className="text-[13px] font-medium text-zinc-300">Auto-apply</p>
            <p className="mt-1 text-[12px] leading-relaxed" style={{ color: '#52525e' }}>
              Automatically clean files, fix registry issues, and install updates without confirmation.
            </p>
          </div>
          <Toggle checked={autoApply} onChange={setAutoApply} />
        </div>

        {autoApply && (
          <div
            className="mb-6 flex items-start gap-3 rounded-xl p-3"
            style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.12)' }}
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: '#f59e0b' }} strokeWidth={1.8} />
            <p className="text-[12px] leading-relaxed" style={{ color: '#d97706' }}>
              Actions will run automatically on schedule. Make sure your exclusions list is up to date.
            </p>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2.5">
          <button
            onClick={onClose}
            className="rounded-xl px-5 py-2.5 text-[13px] font-medium transition-colors"
            style={{ color: '#8e8e96' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSave}
            className={cn(
              'rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-colors',
              !canSave && 'cursor-not-allowed opacity-40'
            )}
            style={{ background: '#f59e0b', color: '#1a0a00' }}
          >
            {isEditing ? 'Save Changes' : 'Create Schedule'}
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
        background: checked ? 'rgba(245,158,11,0.06)' : 'transparent',
        border: checked ? '1px solid rgba(245,158,11,0.15)' : '1px solid transparent'
      }}
    >
      <div
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded"
        style={{
          background: checked ? '#f59e0b' : 'rgba(255,255,255,0.06)',
          border: checked ? 'none' : '1px solid rgba(255,255,255,0.1)'
        }}
      >
        {checked && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 5L4.2 7.5L8 2.5" stroke="#1a0a00" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
      style={{ background: checked ? '#f59e0b' : 'rgba(255,255,255,0.08)' }}
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
      style={{ color: color ?? '#6e6e76' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      <Icon className="h-4 w-4" strokeWidth={1.8} />
    </button>
  )
}

// ─── Utilities ────────────────────────────────────────────

function formatFrequency(entry: ScheduleEntry): string {
  const time = `${String(entry.hour).padStart(2, '0')}:00`
  switch (entry.frequency) {
    case 'daily':
      return `Every day at ${time}`
    case 'weekly':
      return `Every ${DAY_NAMES[entry.day] ?? 'Monday'} at ${time}`
    case 'monthly':
      return `${ordinal(entry.day)} of every month at ${time}`
  }
}

function formatNextRun(date: Date): string {
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffD = Math.floor(diffMs / 86_400_000)
  const time = `${String(date.getHours()).padStart(2, '0')}:00`

  if (diffD === 0 && date.getDate() === now.getDate()) return `Today at ${time}`
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (date.getFullYear() === tomorrow.getFullYear() && date.getMonth() === tomorrow.getMonth() && date.getDate() === tomorrow.getDate()) return `Tomorrow at ${time}`
  if (diffD < 7) return `In ${diffD} days at ${time}`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ` at ${time}`
}

function formatLastRun(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffM = Math.floor(diffMs / 60_000)
  const diffH = Math.floor(diffMs / 3_600_000)
  const diffD = Math.floor(diffMs / 86_400_000)

  if (diffM < 1) return 'Just now'
  if (diffM < 60) return `${diffM}m ago`
  if (diffH < 24) return `${diffH}h ago`
  if (diffD < 7) return `${diffD}d ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
