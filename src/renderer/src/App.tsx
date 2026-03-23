import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Toaster } from 'sonner'
import { RTL_LANGUAGES } from './lib/languages'
import { useScheduledScan } from './hooks/useScheduledScan'
import { AppShell } from './components/layout/AppShell'
import { DashboardPage } from './pages/DashboardPage'
import { CleanerPage } from './pages/CleanerPage'
import { RegistryPage } from './pages/RegistryPage'
import { StartupPage } from './pages/StartupPage'
import { DebloaterPage } from './pages/DebloaterPage'
import { SoftwareUpdaterPage } from './pages/SoftwareUpdaterPage'
import { DriverManagerPage } from './pages/DriverManagerPage'
import { DiskAnalyzerPage } from './pages/DiskAnalyzerPage'
import { DuplicateFinderPage } from './pages/DuplicateFinderPage'
import { LargeFileFinderPage } from './pages/LargeFileFinderPage'
import { EmptyFolderCleanerPage } from './pages/EmptyFolderCleanerPage'
import { FileShredderPage } from './pages/FileShredderPage'
import { SettingsPage } from './pages/SettingsPage'
import { NetworkCleanupPage } from './pages/NetworkCleanupPage'
import { MalwareScannerPage } from './pages/MalwareScannerPage'
import { ThreatMonitorPage } from './pages/ThreatMonitorPage'
import { PrivacyShieldPage } from './pages/PrivacyShieldPage'
import { HistoryPage } from './pages/HistoryPage'
import { PerformanceMonitorPage } from './pages/PerformanceMonitorPage'
import { UninstallerPage } from './pages/UninstallerPage'
import { ServiceManagerPage } from './pages/ServiceManagerPage'
import { SchedulesPage } from './pages/SchedulesPage'
import { GameModePage } from './pages/GameModePage'
import { CveScannerPage } from './pages/CveScannerPage'
import { AboutPage } from './pages/AboutPage'
import { Onboarding } from './components/Onboarding'
import { useStatsStore } from './stores/stats-store'
import { useHistoryStore } from './stores/history-store'
import { useAppUpdateStore } from './stores/app-update-store'
import { useBackgroundScans } from './hooks/useBackgroundScans'
import { usePlatformLoader, PlatformContext } from './hooks/usePlatform'
import { initGameModeStore } from './stores/game-mode-store'

export function App() {
  const { i18n } = useTranslation()
  const loadHistory = useHistoryStore((s) => s.load)
  const historyLoaded = useHistoryStore((s) => s.loaded)
  const recomputeStats = useStatsStore((s) => s.recompute)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingChecked, setOnboardingChecked] = useState(false)

  // Sync RTL direction based on current language
  useEffect(() => {
    document.documentElement.dir = RTL_LANGUAGES.includes(i18n.language) ? 'rtl' : 'ltr'
  }, [i18n.language])

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

  // Hydrate Game Mode status so the sidebar badge works on all pages
  useEffect(() => { initGameModeStore() }, [])

  if (!onboardingChecked) return null

  return (
    <PlatformContext value={platformInfo}>
    <HashRouter>
      <PageTitleUpdater />
      {showOnboarding && <Onboarding onComplete={handleOnboardingComplete} />}
      <AppShell>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/cleaner" element={<CleanerPage />} />
          <Route path="/registry" element={<RegistryPage />} />
          <Route path="/startup" element={<StartupPage />} />
          <Route path="/disk" element={<DiskAnalyzerPage />} />
          <Route path="/duplicates" element={<DuplicateFinderPage />} />
          <Route path="/large-files" element={<LargeFileFinderPage />} />
          <Route path="/empty-folders" element={<EmptyFolderCleanerPage />} />
          <Route path="/file-shredder" element={<FileShredderPage />} />
          <Route path="/network" element={<NetworkCleanupPage />} />
          <Route path="/malware" element={<MalwareScannerPage />} />
          <Route path="/threat-monitor" element={<ThreatMonitorPage />} />
          <Route path="/cve" element={<CveScannerPage />} />
          <Route path="/game-mode" element={<GameModePage />} />
          <Route path="/performance" element={<PerformanceMonitorPage />} />
          <Route path="/uninstaller" element={<UninstallerPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/about" element={<AboutPage />} />
          {/* Standalone pages */}
          <Route path="/privacy" element={<PrivacyShieldPage />} />
          <Route path="/services" element={<ServiceManagerPage />} />
          <Route path="/debloater" element={<DebloaterPage />} />
          <Route path="/updates" element={<SoftwareUpdaterPage />} />
          <Route path="/schedules" element={<SchedulesPage />} />
          {/* Legacy redirect */}
          <Route path="/hardening" element={<Navigate to="/privacy" replace />} />
          <Route path="/updater" element={<SoftwareUpdaterPage />} />
          <Route path="/drivers" element={<DriverManagerPage />} />
        </Routes>
      </AppShell>
      <Toaster
        position="bottom-right"
        theme="dark"
        toastOptions={{
          style: {
            background: 'rgba(20, 20, 28, 0.85)',
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            border: '1px solid rgba(255,255,255,0.08)',
            color: '#fafafa',
            boxShadow: '0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.04)'
          }
        }}
      />
    </HashRouter>
    </PlatformContext>
  )
}

// Maps routes to page titles for the window/tab title.
// Uses sidebar i18n keys where possible; nested routes use plain strings
// so each page gets its own distinct title for screen readers / OS window switcher.
const ROUTE_TITLES: Record<string, { key: string; ns?: string } | string> = {
  '/': { key: 'dashboard' },
  '/cleaner': { key: 'cleaner' },
  '/registry': { key: 'registry' },
  '/startup': { key: 'startup' },
  '/disk': 'Disk Analyzer',
  '/duplicates': 'Duplicate Finder',
  '/large-files': 'Large File Finder',
  '/empty-folders': 'Empty Folder Cleaner',
  '/file-shredder': 'File Shredder',
  '/network': { key: 'network' },
  '/malware': { key: 'malwareScanner' },
  '/threat-monitor': { key: 'threatMonitor' },
  '/cve': { key: 'cveScanner' },
  '/game-mode': { key: 'gameMode' },
  '/performance': { key: 'performance' },
  '/uninstaller': 'Uninstaller',
  '/history': { key: 'history' },
  '/settings': { key: 'settings' },
  '/about': 'About',
  '/privacy': 'Privacy',
  '/services': 'Services',
  '/debloater': 'Bloatware Remover',
  '/updates': 'Software Updates',
  '/schedules': { key: 'schedules' },
  '/drivers': 'Driver Updates',
}

function PageTitleUpdater() {
  const location = useLocation()
  const { t } = useTranslation('sidebar')
  useEffect(() => {
    const entry = ROUTE_TITLES[location.pathname]
    let name: string | null = null
    if (typeof entry === 'string') {
      name = entry
    } else if (entry) {
      name = t(entry.key)
    }
    document.title = name ? `${name} - Kudu` : 'Kudu'
  }, [location.pathname, t])
  return null
}
