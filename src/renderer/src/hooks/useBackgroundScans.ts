import { useEffect, useRef } from 'react'
import { useUpdaterStore } from '@/stores/updater-store'
import { useDriverStore } from '@/stores/driver-store'
import { refreshSettings, useSettingsStore } from '@/stores/settings-store'

/**
 * Runs software-update and driver-update scans silently in the background
 * on first app launch. Populates stores so badge counts appear in the sidebar.
 */
export function useBackgroundScans(): void {
  const driverRan = useRef(false)
  const softwareRan = useRef(false)
  const ignoredLoaded = useRef(false)
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const ignoredSoftwareUpdates = useSettingsStore((s) => s.settings.ignoredSoftwareUpdates)
  const softwareUpdaterNotifications = useSettingsStore(
    (s) => s.settings.softwareUpdaterNotifications ?? true
  )

  // The software check waits on hydrated settings; retry once if the eager
  // hydration in settings-store lost its IPC, so a transient failure doesn't
  // defer that check for the whole session.
  useEffect(() => {
    if (settingsLoaded) return
    const id = setTimeout(refreshSettings, 2000)
    return () => clearTimeout(id)
  }, [settingsLoaded])

  // Load ignored IDs first so setApps() can partition correctly. This runs even
  // when reminders are off, since manual checks on the updater page still need it.
  useEffect(() => {
    if (!settingsLoaded || ignoredLoaded.current) return
    ignoredLoaded.current = true
    if (ignoredSoftwareUpdates?.length) {
      useUpdaterStore.getState().loadIgnoredIds(ignoredSoftwareUpdates)
    }
  }, [settingsLoaded, ignoredSoftwareUpdates])

  // Software update check (silent — no toasts). Deferred while reminders are
  // off, and started on the off-to-on transition without needing a restart.
  useEffect(() => {
    if (!settingsLoaded || !softwareUpdaterNotifications || softwareRan.current) return

    const store = useUpdaterStore.getState()
    if (store.hasChecked || store.loading) return
    softwareRan.current = true
    store.setLoading(true)

    void (async () => {
      try {
        const result = await window.kudu.softwareUpdateCheck()
        const s = useUpdaterStore.getState()
        s.setApps(result.apps)
        s.setUpToDate(result.upToDate)
        s.setPackageManagerAvailable(result.packageManagerAvailable)
        s.setPackageManagerName(result.packageManagerName)
        s.setHasChecked(true)
      } catch {
        // Silent — don't set error so the page still shows its initial state
      } finally {
        useUpdaterStore.getState().setLoading(false)
      }
    })()
  }, [settingsLoaded, softwareUpdaterNotifications])

  // Driver update scan only (we skip the stale-packages scan since it's heavier
  // and less relevant for the badge — the badge shows available driver *updates*)
  useEffect(() => {
    if (driverRan.current) return
    driverRan.current = true

    void (async () => {
      const store = useDriverStore.getState()
      if (store.hasScanned || store.updateScanning) return
      store.setUpdateScanning(true)
      try {
        const result = await window.kudu.driverUpdateScan()
        useDriverStore.getState().setUpdates(result.updates)
      } catch {
        // Silent
      } finally {
        const s = useDriverStore.getState()
        s.setUpdateScanning(false)
        s.setUpdateProgress(null)
      }
    })()
  }, [])
}
