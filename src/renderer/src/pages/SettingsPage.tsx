import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Plus, X, FolderOpen, Sun, Moon, Monitor, Cloud, ChevronRight, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { usePlatform } from '@/hooks/usePlatform'
import { LANGUAGES } from '@/lib/languages'
import i18next from 'i18next'

export function SettingsPage() {
  const { t } = useTranslation('settings')
  const { features, platform } = usePlatform()
  const { settings, updateSettings, setSettings } = useSettingsStore()
  const [newExclusion, setNewExclusion] = useState('')
  const navigate = useNavigate()

  const isLinked = !!settings.cloud.apiKey

  useEffect(() => { window.kudu?.settingsGet?.().then(setSettings).catch(() => {}) }, [])

  const save = (partial: Partial<typeof settings>) => {
    updateSettings(partial)
    window.kudu?.settingsSet?.(partial).catch(() => {})
  }

  const saveStartup = async (enabled: boolean) => {
    save({ runAtStartup: enabled })
    try {
      await window.kudu?.applyStartup?.(enabled)
    } catch {
      // Revert the toggle — the OS rejected the change
      save({ runAtStartup: !enabled })
      toast.error(t('startupSettingFailedToast'), {
        description: t('startupSettingFailedDesc'),
        action: {
          label: t('startupSettingFailedAction'),
          onClick: () => window.open('https://usekudu.com/help/startup-failed', '_blank'),
        },
      })
    }
  }

  const saveTray = (enabled: boolean) => {
    save({ minimizeToTray: enabled })
    window.kudu?.applyTray?.(enabled)
  }

  const addExclusion = () => {
    const value = newExclusion.trim()
    if (!value) return
    // Must be an absolute path or a *.ext glob
    const isDrivePath = /^[A-Za-z]:\\/.test(value)
    const isUncPath = /^\\\\[A-Za-z0-9]/.test(value)
    const isUnixPath = /^\/[A-Za-z0-9]/.test(value)
    const isGlob = /^\*\.[A-Za-z0-9]+$/.test(value)
    // Reject relative path traversal sequences
    if (value.includes('..')) return
    if (!isDrivePath && !isUncPath && !isUnixPath && !isGlob) return
    // Prevent duplicates
    if (settings.exclusions.includes(value)) return
    save({ exclusions: [...settings.exclusions, value] })
    setNewExclusion('')
  }

  const selectStyle = "rounded-lg px-3 py-1.5 text-[13px] text-zinc-400 outline-none"
  const selectBorder = { background: 'var(--bg-subtle-2)', border: '1px solid var(--border-medium)' }

  return (
    <div className="animate-fade-in max-w-2xl">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />

      <Section title={t('sectionGeneral')}>
        <Row label={t('themeLabel', 'Theme')} desc={t('themeDesc', 'Choose between dark and light appearance')}>
          <ThemeSelector value={settings.theme} onChange={(v) => save({ theme: v })} />
        </Row>
        <Row label={t('languageLabel')} desc={t('languageDesc')}>
          <select
            value={settings.language}
            onChange={(e) => {
              save({ language: e.target.value })
              i18next.changeLanguage(e.target.value)
            }}
            className={selectStyle}
            style={selectBorder}
          >
            {LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.nativeName} ({lang.name})
              </option>
            ))}
          </select>
        </Row>
        <Row label={t('runAtStartupLabel')} desc={t('runAtStartupDesc')}>
          <Toggle checked={settings.runAtStartup} onChange={saveStartup} />
        </Row>
        <Row label={t('minimizeToTrayLabel')} desc={t('minimizeToTrayDesc')}>
          <Toggle checked={settings.minimizeToTray} onChange={saveTray} />
        </Row>
        <Row label={t('showNotificationsLabel')} desc={t('showNotificationsDesc')}>
          <Toggle checked={settings.showNotificationOnComplete} onChange={(v) => save({ showNotificationOnComplete: v })} />
        </Row>
        <Row label={t('threatDetectionAlertsLabel')} desc={t('threatDetectionAlertsDesc')}>
          <Toggle checked={settings.showThreatNotifications} onChange={(v) => save({ showThreatNotifications: v })} />
        </Row>
        <Row label={t('autoUpdateLabel')} desc={t('autoUpdateDesc')}>
          <Toggle checked={settings.autoUpdate} onChange={(v) => save({ autoUpdate: v })} />
        </Row>
        <Row label={t('autoRestartLabel')} desc={t('autoRestartDesc')}>
          <Toggle checked={settings.autoRestart} onChange={(v) => save({ autoRestart: v })} />
        </Row>
        <Row label={t('updateCheckIntervalLabel')} desc={t('updateCheckIntervalDesc')} last={platform !== 'win32'}>
          <select value={settings.updateCheckIntervalHours}
            onChange={(e) => save({ updateCheckIntervalHours: Number(e.target.value) })}
            className={selectStyle} style={selectBorder}>
            <option value={1}>{t('updateCheckEveryHour')}</option>
            <option value={4}>{t('updateCheckEvery4Hours')}</option>
            <option value={12}>{t('updateCheckEvery12Hours')}</option>
            <option value={24}>{t('updateCheckOnceADay')}</option>
          </select>
        </Row>
        {platform === 'win32' && (
          <Row label={t('windowsPackageManagerLabel')} desc={t('windowsPackageManagerDesc')} last>
            <select
              value={settings.windowsPackageManager ?? 'winget'}
              onChange={(e) => save({ windowsPackageManager: e.target.value as 'winget' | 'choco' })}
              className={selectStyle} style={selectBorder}
            >
              <option value="winget">winget</option>
              <option value="choco">Chocolatey</option>
            </select>
          </Row>
        )}
      </Section>

      <Section title={t('sectionCloudDashboard')}>
        <button
          onClick={() => navigate('/cloud')}
          className="flex w-full items-center gap-4 rounded-xl p-4 text-left transition-all"
          style={{ background: 'var(--accent-muted-bg)', border: '1px solid var(--accent-muted-border)' }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(245,158,11,0.3)' }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--accent-muted-border)' }}
        >
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
            style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)' }}
          >
            <Cloud className="h-5 w-5 text-black" strokeWidth={2} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-zinc-200">
              {isLinked ? t('cloudLinkedCardTitle') : t('cloudUnlinkedCardTitle')}
            </p>
            <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
              {isLinked ? t('cloudLinkedCardDesc') : t('cloudUnlinkedCardDesc')}
            </p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0" style={{ color: 'var(--text-muted)' }} strokeWidth={1.8} />
        </button>
      </Section>

      <Section title={t('sectionBackups', 'Backups')}>
        <BackupFolderRow
          path={settings.backupPath}
          onPick={async () => {
            const picked = await window.kudu?.settingsSelectBackupDir?.()
            if (picked) {
              save({ backupPath: picked })
              toast.success(t('backupFolderUpdatedToast', 'Backup folder updated'), {
                description: t('backupFolderUpdatedDesc', 'Existing backups remain in their previous location.'),
              })
            }
          }}
          onOpen={() => { window.kudu?.settingsOpenBackupDir?.().catch(() => {}) }}
          onReset={() => save({ backupPath: '' })}
        />
      </Section>

      <Section title={t('sectionCleaningPreferences')}>
        <Row label={t('protectRecycleBinLabel')} desc={t('protectRecycleBinDesc')}>
          <Toggle checked={settings.cleaner.protectRecycleBin} onChange={(v) => save({ cleaner: { ...settings.cleaner, protectRecycleBin: v } })} />
        </Row>
        <Row label={t('secureDeleteLabel')} desc={t('secureDeleteDesc')}>
          <Toggle checked={settings.cleaner.secureDelete} onChange={(v) => save({ cleaner: { ...settings.cleaner, secureDelete: v } })} />
        </Row>
        <Row label={t('closeBrowsersLabel')} desc={t('closeBrowsersDesc')}>
          <Toggle checked={settings.cleaner.closeBrowsersBeforeClean} onChange={(v) => save({ cleaner: { ...settings.cleaner, closeBrowsersBeforeClean: v } })} />
        </Row>
        {features.restorePoint && (
          <Row label={t('createRestorePointLabel')} desc={t('createRestorePointDesc')}>
            <Toggle checked={settings.cleaner.createRestorePoint} onChange={(v) => save({ cleaner: { ...settings.cleaner, createRestorePoint: v } })} />
          </Row>
        )}
        <Row label={t('skipRecentFilesLabel')} desc={t('skipRecentFilesDesc')} last>
          <select value={settings.cleaner.skipRecentMinutes}
            onChange={(e) => save({ cleaner: { ...settings.cleaner, skipRecentMinutes: Number(e.target.value) } })}
            className={selectStyle} style={selectBorder}>
            <option value={30}>{t('skipRecent30Min')}</option>
            <option value={60}>{t('skipRecent1Hour')}</option>
            <option value={120}>{t('skipRecent2Hours')}</option>
            <option value={1440}>{t('skipRecent24Hours')}</option>
          </select>
        </Row>
      </Section>

      <Section title={t('sectionExclusions')}>
        <div className="space-y-2 pb-3">
          {settings.exclusions.length === 0 && (
            <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>{t('noExclusionsConfigured')}</p>
          )}
          {settings.exclusions.map((exc, i) => (
            <div key={i} className="flex items-center justify-between rounded-xl px-4 py-2.5"
              style={{ background: 'var(--bg-subtle)' }}>
              <div className="flex items-center gap-2.5">
                <FolderOpen className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} strokeWidth={1.8} />
                <span className="font-mono text-[12px] text-zinc-400">{exc}</span>
              </div>
              <button onClick={() => save({ exclusions: settings.exclusions.filter((_, j) => j !== i) })}
                className="rounded-lg p-1.5 transition-colors" style={{ color: 'var(--text-muted)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2.5">
            <input type="text" value={newExclusion} onChange={(e) => setNewExclusion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addExclusion()}
              placeholder={platform === 'win32' ? t('exclusionPlaceholderWindows') : t('exclusionPlaceholderOther')}
              className="flex-1 rounded-xl px-4 py-2.5 text-[13px] text-zinc-300 outline-none placeholder:text-zinc-700"
              style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-medium)' }} />
            <button onClick={addExclusion}
              className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] font-medium text-zinc-400 transition-colors"
              style={{ background: 'var(--bg-subtle-2)', border: '1px solid var(--border-medium)' }}>
              <Plus className="h-3.5 w-3.5" /> {t('addButton')}
            </button>
          </div>
        </div>
      </Section>

    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-7">
      <h3 className="mb-3 text-[11px] font-medium uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>{title}</h3>
      <div className="rounded-2xl p-5" style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}>{children}</div>
    </div>
  )
}

function Row({ label, desc, children, last }: { label: string; desc?: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between py-3.5', !last && 'border-b')}
      style={!last ? { borderColor: 'var(--border-subtle)' } : undefined}>
      <div>
        <p className="text-[13px] font-medium text-zinc-300">{label}</p>
        {desc && <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>{desc}</p>}
      </div>
      {children}
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)}
      className="relative h-[26px] w-[46px] shrink-0 rounded-full transition-colors"
      style={{ background: checked ? 'var(--accent)' : 'var(--bg-active)' }}>
      <div className={cn(
        'absolute top-[3px] h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
        checked ? 'translate-x-[22px]' : 'translate-x-[3px]'
      )} />
    </button>
  )
}

function BackupFolderRow({
  path,
  onPick,
  onOpen,
  onReset,
}: {
  path: string
  onPick: () => void
  onOpen: () => void
  onReset: () => void
}) {
  const { t } = useTranslation('settings')
  const isCustom = path.length > 0
  const displayPath = isCustom ? path : t('backupFolderDefaultLabel', 'Default (Documents/Kudu Backups)')
  return (
    <div className="space-y-3">
      <div>
        <p className="text-[13px] font-medium text-zinc-300">{t('backupFolderLabel', 'Backup folder')}</p>
        <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
          {t('backupFolderDesc', 'Where Kudu writes registry and shell-extension backups before making changes. Existing backups stay in their previous location when you switch folders.')}
        </p>
      </div>
      <div className="flex items-center gap-2.5">
        <div
          className="flex flex-1 items-center gap-2.5 rounded-xl px-4 py-2.5"
          style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-medium)' }}
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} strokeWidth={1.8} />
          <span className="truncate font-mono text-[12px] text-zinc-400" title={displayPath}>{displayPath}</span>
        </div>
        <button
          onClick={onOpen}
          title={t('backupFolderOpenTooltip', 'Open in file manager')}
          className="rounded-xl p-2.5 text-zinc-400 transition-colors"
          style={{ background: 'var(--bg-subtle-2)', border: '1px solid var(--border-medium)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-subtle-2)' }}
        >
          <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.8} />
        </button>
        {isCustom && (
          <button
            onClick={onReset}
            title={t('backupFolderResetTooltip', 'Reset to default')}
            className="rounded-xl p-2.5 text-zinc-400 transition-colors"
            style={{ background: 'var(--bg-subtle-2)', border: '1px solid var(--border-medium)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-subtle-2)' }}
          >
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.8} />
          </button>
        )}
        <button
          onClick={onPick}
          className="rounded-xl px-4 py-2.5 text-[13px] font-medium text-zinc-400 transition-colors"
          style={{ background: 'var(--bg-subtle-2)', border: '1px solid var(--border-medium)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-subtle-2)' }}
        >
          {t('backupFolderChooseButton', 'Choose…')}
        </button>
      </div>
    </div>
  )
}

function ThemeSelector({ value, onChange }: { value: 'dark' | 'light' | 'system'; onChange: (v: 'dark' | 'light' | 'system') => void }) {
  const options: { id: 'dark' | 'light' | 'system'; icon: typeof Sun; label: string }[] = [
    { id: 'dark', icon: Moon, label: 'Dark' },
    { id: 'light', icon: Sun, label: 'Light' },
    { id: 'system', icon: Monitor, label: 'System' },
  ]
  return (
    <div className="flex gap-1 rounded-lg p-0.5" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-medium)' }}>
      {options.map((opt) => {
        const active = value === opt.id
        return (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-all"
            style={{
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? 'var(--text-on-accent)' : 'var(--text-muted)',
            }}
          >
            <opt.icon className="h-3.5 w-3.5" strokeWidth={1.8} />
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

