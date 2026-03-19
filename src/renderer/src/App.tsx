import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route } from 'react-router-dom'
import { Toaster } from 'sonner'
import { useScheduledScan } from './hooks/useScheduledScan'
import { AppShell } from './components/layout/AppShell'
import { DashboardPage } from './pages/DashboardPage'
import { CleanerPage } from './pages/CleanerPage'
import { RegistryPage } from './pages/RegistryPage'
import { StartupPage } from './pages/StartupPage'
import { DebloaterPage } from './pages/DebloaterPage'
import { SystemHardeningPage } from './pages/SystemHardeningPage'
import { UpdatesPage } from './pages/UpdatesPage'
import { DiskAnalyzerPage } from './pages/DiskAnalyzerPage'
import { SettingsPage } from './pages/SettingsPage'
import { NetworkCleanupPage } from './pages/NetworkCleanupPage'
import { MalwareScannerPage } from './pages/MalwareScannerPage'
import { ThreatMonitorPage } from './pages/ThreatMonitorPage'
import { PrivacyShieldPage } from './pages/PrivacyShieldPage'
import { HistoryPage } from './pages/HistoryPage'
import { DriverManagerPage } from './pages/DriverManagerPage'
import { PerformanceMonitorPage } from './pages/PerformanceMonitorPage'
import { UninstallerPage } from './pages/UninstallerPage'
import { ServiceManagerPage } from './pages/ServiceManagerPage'
import { SoftwareUpdaterPage } from './pages/SoftwareUpdaterPage'
import { SchedulesPage } from './pages/SchedulesPage'
import { Onboarding } from './components/Onboarding'
import { useStatsStore } from './stores/stats-store'
import { useHistoryStore } from './stores/history-store'
import { useAppUpdateStore } from './stores/app-update-store'
import { useBackgroundScans } from './hooks/useBackgroundScans'
import { usePlatformLoader, PlatformContext } from './hooks/usePlatform'

export function App() {
  const loadHistory = useHistoryStore((s) => s.load)
  const historyLoaded = useHistoryStore((s) => s.loaded)
  const recomputeStats = useStatsStore((s) => s.recompute)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingChecked, setOnboardingChecked] = useState(false)

  useEffect(() => {
    window.kudu?.onboardingGet?.().then((done) => {
      setShowOnboarding(!done)
      setOnboardingChecked(true)
    }).catch(() => setOnboardingChecked(true))
  }, [])

  const handleOnboardingComplete = () => {
    window.kudu?.onboardingSet?.(true).catch(() => {})
    setShowOnboarding(false)
  }

  useEffect(() => {
    if (!historyLoaded) loadHistory()
  }, [historyLoaded, loadHistory])

  useEffect(() => {
    if (historyLoaded) recomputeStats()
  }, [historyLoaded, recomputeStats])

  const platformInfo = usePlatformLoader()

  useScheduledScan()

  // Run software-update & driver-update scans silently in the background
  useBackgroundScans()

  // Initialize app update checker on mount
  const initAppUpdate = useAppUpdateStore((s) => s.init)
  useEffect(() => {
    const cleanup = initAppUpdate()
    return cleanup
  }, [initAppUpdate])

  if (!onboardingChecked) return null

  return (
    <PlatformContext value={platformInfo}>
    <HashRouter>
      {showOnboarding && <Onboarding onComplete={handleOnboardingComplete} />}
      <AppShell>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/cleaner" element={<CleanerPage />} />
          <Route path="/registry" element={<RegistryPage />} />
          <Route path="/startup" element={<StartupPage />} />
          <Route path="/disk" element={<DiskAnalyzerPage />} />
          <Route path="/network" element={<NetworkCleanupPage />} />
          <Route path="/malware" element={<MalwareScannerPage />} />
          <Route path="/threat-monitor" element={<ThreatMonitorPage />} />
          <Route path="/performance" element={<PerformanceMonitorPage />} />
          <Route path="/uninstaller" element={<UninstallerPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          {/* Consolidated pages */}
          <Route path="/hardening" element={<SystemHardeningPage />} />
          <Route path="/updates" element={<UpdatesPage />} />
          <Route path="/schedules" element={<SchedulesPage />} />
          {/* Legacy routes — redirect to consolidated pages */}
          <Route path="/privacy" element={<SystemHardeningPage />} />
          <Route path="/debloater" element={<SystemHardeningPage />} />
          <Route path="/services" element={<SystemHardeningPage />} />
          <Route path="/updater" element={<UpdatesPage />} />
          <Route path="/drivers" element={<UpdatesPage />} />
        </Routes>
      </AppShell>
      <Toaster
        position="bottom-right"
        theme="dark"
        toastOptions={{
          style: {
            background: '#18181b',
            border: '1px solid #3f3f46',
            color: '#fafafa'
          }
        }}
      />
    </HashRouter>
    </PlatformContext>
  )
}
