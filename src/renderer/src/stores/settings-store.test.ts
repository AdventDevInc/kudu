import { describe, it, expect, beforeEach, vi } from 'vitest'

// Stub window.kudu to prevent eager hydration side-effect
vi.stubGlobal('window', { kudu: undefined })

import { useSettingsStore } from './settings-store'

describe('settings-store', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: {
        theme: 'dark',
        language: 'en',
        minimizeToTray: false,
        showNotificationOnComplete: true,
        showThreatNotifications: true,
        runAtStartup: false,
        autoUpdate: true,
        autoRestart: true,
        updateCheckIntervalHours: 4,
        cleaner: {
          skipRecentMinutes: 60,
          secureDelete: false,
          closeBrowsersBeforeClean: false,
          createRestorePoint: false,
        },
        exclusions: [],
        schedule: {
          enabled: false,
          frequency: 'weekly',
          day: 1,
          hour: 9,
        },
        schedules: [],
        cloud: {
          apiKey: '',
          telemetryIntervalSec: 60,
          shareDiskHealth: true,
          shareProcessList: true,
          shareThreatMonitor: true,
          allowRemotePower: true,
          allowRemoteCleanup: true,
          allowRemoteInstalls: true,
          allowRemoteConfig: true,
        },
      },
      loaded: false,
    })
  })

  it('starts with loaded = false', () => {
    expect(useSettingsStore.getState().loaded).toBe(false)
  })

  it('setSettings replaces all settings and sets loaded', () => {
    const newSettings = {
      ...useSettingsStore.getState().settings,
      minimizeToTray: true,
      runAtStartup: true,
    }
    useSettingsStore.getState().setSettings(newSettings)

    const state = useSettingsStore.getState()
    expect(state.loaded).toBe(true)
    expect(state.settings.minimizeToTray).toBe(true)
    expect(state.settings.runAtStartup).toBe(true)
  })

  it('updateSettings merges top-level properties', () => {
    useSettingsStore.getState().updateSettings({ minimizeToTray: true })
    expect(useSettingsStore.getState().settings.minimizeToTray).toBe(true)
    // Other settings remain unchanged
    expect(useSettingsStore.getState().settings.autoUpdate).toBe(true)
  })

  it('updateSettings deep-merges cleaner settings', () => {
    useSettingsStore.getState().updateSettings({
      cleaner: { secureDelete: true },
    } as any)

    const { cleaner } = useSettingsStore.getState().settings
    expect(cleaner.secureDelete).toBe(true)
    // Other cleaner settings remain
    expect(cleaner.skipRecentMinutes).toBe(60)
    expect(cleaner.closeBrowsersBeforeClean).toBe(false)
  })

  it('updateSettings deep-merges schedule settings', () => {
    useSettingsStore.getState().updateSettings({
      schedule: { enabled: true, hour: 22 },
    } as any)

    const { schedule } = useSettingsStore.getState().settings
    expect(schedule.enabled).toBe(true)
    expect(schedule.hour).toBe(22)
    // Preserved
    expect(schedule.frequency).toBe('weekly')
    expect(schedule.day).toBe(1)
  })

  it('updateSettings deep-merges cloud settings', () => {
    useSettingsStore.getState().updateSettings({
      cloud: { apiKey: 'test-key', allowRemotePower: false },
    } as any)

    const { cloud } = useSettingsStore.getState().settings
    expect(cloud.apiKey).toBe('test-key')
    expect(cloud.allowRemotePower).toBe(false)
    // Preserved
    expect(cloud.telemetryIntervalSec).toBe(60)
    expect(cloud.shareProcessList).toBe(true)
  })

  it('updateSettings does not clobber nested objects when only top-level changes', () => {
    useSettingsStore.getState().updateSettings({ autoRestart: false })
    const { cleaner, schedule, cloud } = useSettingsStore.getState().settings
    expect(cleaner.skipRecentMinutes).toBe(60)
    expect(schedule.frequency).toBe('weekly')
    expect(cloud.telemetryIntervalSec).toBe(60)
  })

  it('default settings have sensible values', () => {
    const { settings } = useSettingsStore.getState()
    expect(settings.updateCheckIntervalHours).toBe(4)
    expect(settings.cleaner.skipRecentMinutes).toBe(60)
    expect(settings.schedule.enabled).toBe(false)
    expect(settings.exclusions).toEqual([])
  })
})
