import type { DriverPackage, DriverUpdate } from '@shared/types'

// Browser-only fixtures: these operations never reach the native driver bridge.
export function driverReads(empty: boolean) {
  const scenario = new URLSearchParams(location.search).get('drivers')
  let packages: DriverPackage[] = empty
    ? []
    : [
        {
          id: 'old-display',
          publishedName: 'oem42.inf',
          originalName: 'nv_dispi.inf',
          provider: 'NVIDIA',
          className: 'Display adapters',
          version: '32.0.15.6094',
          date: '2024-08-14',
          signer: 'Microsoft Windows Hardware Compatibility Publisher',
          folderPath: '',
          size: 420 * 1024 ** 2,
          isCurrent: false,
          selected: true
        },
        {
          id: 'old-audio',
          publishedName: 'oem18.inf',
          originalName: 'hdxrt.inf',
          provider: 'Realtek',
          className: 'Sound devices',
          version: '6.0.9600.1',
          date: '2023-11-02',
          signer: 'Microsoft Windows Hardware Compatibility Publisher',
          folderPath: '',
          size: 85 * 1024 ** 2,
          isCurrent: false,
          selected: true
        }
      ]
  let updates: DriverUpdate[] = empty
    ? []
    : [
        {
          id: 'display',
          updateId: 'preview-display',
          deviceName: 'NVIDIA GeForce RTX 4090',
          deviceId: 'preview-gpu',
          className: 'Display adapters',
          currentVersion: '32.0.15.6094',
          currentDate: '2024-08-14',
          availableVersion: '32.0.15.7680',
          availableDate: '2025-06-12',
          provider: 'NVIDIA',
          updateTitle: 'NVIDIA display driver',
          downloadSize: '640 MB',
          selected: true,
          isHidden: false
        },
        {
          id: 'network',
          updateId: 'preview-network',
          deviceName: 'Intel Wi-Fi 6E AX211',
          deviceId: 'preview-wifi',
          className: 'Network adapters',
          currentVersion: '23.60.1.2',
          currentDate: '2024-07-01',
          availableVersion: '23.120.0.3',
          availableDate: '2025-04-15',
          provider: 'Intel',
          updateTitle: 'Intel network driver',
          downloadSize: '32 MB',
          selected: true,
          isHidden: false
        }
      ]
  let ignored: DriverUpdate[] = []
  return {
    driverScan: () => {
      if (scenario === 'error') throw new Error('Sample driver scan failure')
      return {
        packages: structuredClone(packages),
        totalStaleCount: packages.length,
        totalCurrentCount: 0,
        totalStaleSize: packages.reduce((size, pkg) => size + pkg.size, 0)
      }
    },
    driverUpdateScan: () => {
      if (scenario === 'error') throw new Error('Sample update scan failure')
      return {
        updates: scenario === 'disabled' ? [] : structuredClone(updates),
        ignoredUpdates: structuredClone(ignored),
        totalAvailable: updates.length,
        scanDuration: 100,
        updatesDisabled: scenario === 'disabled'
      }
    },
    driverUpdateIgnore: (updateId: string, hide: boolean) => {
      const source = hide ? updates : ignored
      const found = source.find((update) => update.updateId === updateId)
      if (found) {
        updates = updates.filter((update) => update.updateId !== updateId)
        ignored = ignored.filter((update) => update.updateId !== updateId)
        ;(hide ? ignored : updates).push({ ...found, selected: !hide, isHidden: hide })
      }
      // The native bridge uses this flag for a successful hide OR restore.
      return { windowsUpdateHidden: true }
    },
    driverUpdateInstall: async (ids: string[]) => {
      await new Promise((resolve) => setTimeout(resolve, 800))
      const installed = updates.filter((update) => ids.includes(update.updateId)).length
      updates = updates.filter((update) => !ids.includes(update.updateId))
      return { installed, failed: 0, rebootRequired: installed > 0, errors: [] }
    },
    driverClean: (names: string[]) => {
      const removed = packages.filter((pkg) => names.includes(pkg.publishedName))
      packages = packages.filter((pkg) => !names.includes(pkg.publishedName))
      return {
        removed: removed.length,
        failed: 0,
        spaceRecovered: removed.reduce((size, pkg) => size + pkg.size, 0),
        errors: []
      }
    }
  }
}
