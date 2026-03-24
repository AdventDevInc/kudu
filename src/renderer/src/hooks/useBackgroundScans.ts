import { useEffect, useRef } from 'react'
import { useUpdaterStore } from '@/stores/updater-store'
import { useDriverStore } from '@/stores/driver-store'

/**
 * Runs software-update and driver-update scans silently in the background
 * on first app launch. Populates stores so badge counts appear in the sidebar.
 */
export function useBackgroundScans(): void {
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    // Software update check (silent — no toasts)
    // Load ignored IDs first so setApps() can partition correctly
    const runSoftwareCheck = async () => {
      try {
        const settings = await window.kudu.settingsGet()
        if (settings.ignoredSoftwareUpdates?.length) {
          useUpdaterStore.getState().loadIgnoredIds(settings.ignoredSoftwareUpdates)
        }
      } catch { /* best-effort */ }

      const store = useUpdaterStore.getState()
      if (store.hasChecked || store.loading) return
      store.setLoading(true)
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
    }

    // Driver update scan only (we skip the stale-packages scan since it's heavier
    // and less relevant for the badge — the badge shows available driver *updates*)
    const runDriverUpdateScan = async () => {
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
    }

    // Run both in parallel
    runSoftwareCheck()
    runDriverUpdateScan()
  }, [])
}
