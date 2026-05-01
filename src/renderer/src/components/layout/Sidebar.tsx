import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  LayoutDashboard,
  Sparkles,
  Database,
  Zap,
  HardDrive,
  Settings,
  Wifi,
  History,
  Info,
  ShieldAlert,
  Shield,
  Radar,
  Activity,
  Trash2,
  Download,
  CalendarClock,
  Gamepad2,
  Bug,
  ChevronRight,
  CopyCheck,
  FileUp,
  FolderX,
  ShieldAlert as ShieldAlertIcon,
  Wrench,
  Eraser,
  Cpu,
  Package,
  Eye,
  Server,
  Flame,
  PackageMinus,
  Cloud,
  Mail,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'
import logoSrc from '@/assets/logo.png'
import { useThreatMonitorStore } from '@/stores/threat-monitor-store'
import { useAppUpdateStore } from '@/stores/app-update-store'
import { useUpdaterStore } from '@/stores/updater-store'
import { useDriverStore } from '@/stores/driver-store'
import { useGameModeStore } from '@/stores/game-mode-store'
import { useCveStore } from '@/stores/cve-store'
import { useBreachStore } from '@/stores/breach-store'
import { useSettingsStore } from '@/stores/settings-store'
import { usePlatform } from '@/hooks/usePlatform'

interface SubItemDef {
  icon: LucideIcon
  label?: string
  labelKey?: string
  path: string
  badge?: boolean
}

interface NavItemDef {
  icon: LucideIcon
  labelKey: string
  path: string
  children?: SubItemDef[]
}

interface NavGroup {
  headingKey?: string
  items: NavItemDef[]
}

const navGroups: NavGroup[] = [
  {
    items: [{ icon: LayoutDashboard, labelKey: 'dashboard', path: '/' }]
  },
  {
    headingKey: 'securityHeading',
    items: [
      { icon: ShieldAlert, labelKey: 'malwareScanner', path: '/malware' },
      {
        icon: Shield, labelKey: 'systemHardening', path: '/hardening',
        children: [
          { icon: Eye, label: 'Privacy', path: '/privacy' },
          { icon: Server, label: 'Services', path: '/services' },
          { icon: Flame, label: 'Firewall Audit', path: '/firewall' },
        ]
      },
      {
        icon: Radar, labelKey: 'monitoring', path: '/monitoring',
        children: [
          { icon: Radar, labelKey: 'threatMonitor', path: '/threat-monitor' },
          { icon: Bug, labelKey: 'cveScanner', path: '/cve' },
          { icon: Mail, labelKey: 'breachMonitor', path: '/breach-monitor' },
        ]
      },
    ]
  },
  {
    headingKey: 'maintainHeading',
    items: [
      { icon: Sparkles, labelKey: 'cleaner', path: '/cleaner' },
      { icon: Database, labelKey: 'registry', path: '/registry' },
      { icon: Zap, labelKey: 'startup', path: '/startup' },
      { icon: Wifi, labelKey: 'network', path: '/network' },
      {
        icon: Package, labelKey: 'software', path: '/software',
        children: [
          { icon: Download, label: 'Software Updates', path: '/updates' },
          { icon: Cpu, label: 'Driver Updates', path: '/drivers' },
          { icon: Trash2, label: 'Uninstaller', path: '/uninstaller' },
          { icon: PackageMinus, label: 'Bloatware Remover', path: '/debloater' },
        ]
      },
      { icon: CalendarClock, labelKey: 'schedules', path: '/schedules' }
    ]
  },
  {
    headingKey: 'toolsHeading',
    items: [
      { icon: Gamepad2, labelKey: 'gameMode', path: '/game-mode' },
      { icon: Activity, labelKey: 'performance', path: '/performance' },
      {
        icon: HardDrive, labelKey: 'diskTools', path: '/disk',
        children: [
          { icon: HardDrive, label: 'Disk Analyzer', path: '/disk' },
          { icon: CopyCheck, label: 'Duplicate Finder', path: '/duplicates' },
          { icon: FileUp, label: 'Large File Finder', path: '/large-files' },
          { icon: FolderX, label: 'Empty Folder Cleaner', path: '/empty-folders' },
          { icon: ShieldAlertIcon, label: 'File Shredder', path: '/file-shredder' },
          { icon: Wrench, label: 'Disk Repair', path: '/disk-repair' },
          { icon: Eraser, label: 'Disk Maintenance', path: '/disk-maintenance' },
        ]
      },
    ]
  }
]

function useBottomNavItems(): NavItemDef[] {
  const updateState = useAppUpdateStore((s) => s.status.state)
  const showUpdateBadge = updateState === 'available' || updateState === 'downloaded'

  return [
    {
      icon: Settings, labelKey: 'settings', path: '/settings',
      children: [
        { icon: Settings, label: 'Preferences', path: '/settings' },
        { icon: Cloud, label: 'Cloud', path: '/cloud' },
        { icon: History, label: 'History', path: '/history' },
        { icon: Info, label: 'About & Updates', path: '/about', badge: showUpdateBadge },
      ]
    }
  ]
}

// Map nav paths to badge counts from stores
function useBadgeCounts(): Record<string, number> {
  const updaterApps = useUpdaterStore((s) => s.apps)
  const driverUpdates = useDriverStore((s) => s.updates)
  const threatSnapshot = useThreatMonitorStore((s) => s.snapshot)
  const threatCount = (threatSnapshot?.flaggedConnections.length ?? 0) + (threatSnapshot?.flaggedDns.length ?? 0)
  const gameModeActive = useGameModeStore((s) => s.active)
  const cveTotal = useCveStore((s) => s.total)
  const breachEmails = useBreachStore((s) => s.emails)
  const breachTotal = breachEmails.reduce((sum, e) => sum + e.breaches.filter((b) => !b.acknowledgedAt).length, 0)

  const updatesCount = updaterApps.length + driverUpdates.length

  return {
    '/updates': updaterApps.length,
    '/software': updatesCount,
    '/drivers': driverUpdates.length,
    '/threat-monitor': threatCount,
    '/game-mode': gameModeActive ? 1 : 0,
    '/cve': cveTotal,
    '/breach-monitor': breachTotal,
  }
}

export function Sidebar() {
  const { t } = useTranslation('sidebar')
  const location = useLocation()
  const badgeCounts = useBadgeCounts()
  const { features } = usePlatform()
  const threatMonitorLoaded = useThreatMonitorStore((s) => s.loaded)
  const threatBlacklistActive = useThreatMonitorStore((s) => s.snapshot) !== null
  const isCloudLinked = !!useSettingsStore((s) => s.settings.cloud.apiKey)
  const [cloudConnected, setCloudConnected] = useState(false)
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null)

  // Poll cloud connection status so CVE item hides when disconnected
  useEffect(() => {
    if (!isCloudLinked) { setCloudConnected(false); return }
    let cancelled = false
    const check = () => {
      window.kudu?.cloudGetStatus?.().then((s) => {
        if (!cancelled) setCloudConnected(s.status === 'connected')
      }).catch(() => { if (!cancelled) setCloudConnected(false) })
    }
    check()
    const id = setInterval(check, 10_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [isCloudLinked])

  // Filter nav items based on platform features and cloud state
  const filteredNavGroups = navGroups.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (item.path === '/registry' && !features.registry) return false
      if (item.path === '/game-mode' && !features.gameMode) return false
      return true
    }).map((item) => {
      if (!item.children) return item
      const filtered = item.children.filter((child) => {
        if (child.path === '/debloater' && !features.debloater) return false
        if (child.path === '/drivers' && !features.drivers) return false
        if (child.path === '/firewall' && !features.firewallAudit) return false
        if (child.path === '/threat-monitor' && !(threatMonitorLoaded && threatBlacklistActive)) return false
        if (child.path === '/cve' && !cloudConnected) return false
        if (child.path === '/breach-monitor' && !cloudConnected) return false
        return true
      })
      return { ...item, children: filtered }
    }).filter((item) => {
      if (item.children && item.children.length === 0) return false
      return true
    }),
  }))

  // Compute parent badge counts from visible children only
  const effectiveBadgeCounts = { ...badgeCounts }
  for (const group of filteredNavGroups) {
    for (const item of group.items) {
      if (item.children && item.children.length > 0) {
        effectiveBadgeCounts[item.path] = item.children.reduce(
          (sum, child) => sum + (badgeCounts[child.path] ?? 0), 0
        )
      }
    }
  }

  const isPathActive = (item: NavItemDef) => {
    if (item.children) {
      return item.children.some((c) => c.path === location.pathname)
    }
    return location.pathname === item.path
  }

  const submenuProps = {
    openSubmenu,
    onToggleSubmenu: (path: string) => setOpenSubmenu((prev) => prev === path ? null : path),
    onCloseSubmenu: () => setOpenSubmenu(null),
  }

  return (
    <div
      className="flex h-full w-[240px] shrink-0 flex-col"
      style={{
        background: 'var(--sidebar-bg)',
        borderRight: '1px solid var(--border-medium)'
      }}
    >
      {/* Logo — doubles as drag region */}
      <div className="drag-region relative flex items-center gap-3 px-5 pb-4 pt-5">
        <div
          className="absolute left-5 top-5 h-8 w-8 rounded-xl opacity-25 blur-xl"
          style={{ background: 'var(--accent)' }}
        />
        <img src={logoSrc} alt="Kudu" className="relative h-8 w-8 shrink-0 rounded-xl" />
        <div>
          <div className="text-[13px] font-semibold text-white">{t('appName')}</div>
          <div className="text-[9px] font-medium tracking-wide" style={{ color: 'var(--text-dim)' }}>
            {t('subtitle')}
          </div>
        </div>
      </div>

      {/* Nav items */}
      <nav className="mt-1 min-h-0 flex-1 overflow-y-auto px-3" aria-label={t('mainNavigation', 'Main navigation')}>
        {filteredNavGroups.map((group, gi) => (
          <div key={gi} className={gi > 0 ? 'mt-5' : ''} role={group.headingKey ? 'group' : undefined} aria-labelledby={group.headingKey ? `nav-group-${gi}` : undefined}>
            {group.headingKey && (
              <div className="mb-2 flex items-center gap-2.5 px-3 pt-0.5">
                <span
                  id={`nav-group-${gi}`}
                  className="text-[10px] font-semibold uppercase tracking-[0.15em]"
                  style={{ color: 'var(--text-faint)' }}
                >
                  {t(group.headingKey)}
                </span>
                <div className="h-px flex-1" style={{ background: 'var(--border-subtle)' }} />
              </div>
            )}
            <div className="space-y-1">
              {group.items.map((item) => (
                <NavItem
                  key={item.path}
                  item={item}
                  badgeCount={effectiveBadgeCounts[item.path]}
                  badgeCounts={effectiveBadgeCounts}
                  isActive={isPathActive(item)}
                  submenuOpen={openSubmenu === item.path}
                  {...submenuProps}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom */}
      <BottomNav submenuProps={submenuProps} openSubmenu={openSubmenu} isPathActive={isPathActive} badgeCounts={effectiveBadgeCounts} />
    </div>
  )
}

function BottomNav({ submenuProps, openSubmenu, isPathActive, badgeCounts }: {
  submenuProps: { openSubmenu: string | null; onToggleSubmenu: (path: string) => void; onCloseSubmenu: () => void }
  openSubmenu: string | null
  isPathActive: (item: NavItemDef) => boolean
  badgeCounts: Record<string, number>
}) {
  const bottomNavItems = useBottomNavItems()

  return (
    <div className="px-3 pb-3 pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
      {bottomNavItems.map((item) => (
        <NavItem
          key={item.path}
          item={item}
          badgeCount={badgeCounts[item.path]}
          badgeCounts={badgeCounts}
          isActive={isPathActive(item)}
          submenuOpen={openSubmenu === item.path}
          {...submenuProps}
        />
      ))}
    </div>
  )
}

function NavItem({
  item,
  badge,
  badgeCount,
  badgeCounts,
  isActive: isActiveProp,
  submenuOpen,
  onToggleSubmenu,
  onCloseSubmenu,
}: {
  item: NavItemDef
  badge?: boolean
  badgeCount?: number
  badgeCounts?: Record<string, number>
  isActive?: boolean
  submenuOpen?: boolean
  openSubmenu?: string | null
  onToggleSubmenu?: (path: string) => void
  onCloseSubmenu?: () => void
}) {
  const { t } = useTranslation('sidebar')
  const location = useLocation()
  const navigate = useNavigate()
  const isActive = isActiveProp ?? location.pathname === item.path
  const hasChildren = item.children && item.children.length > 0
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Close popover on click outside
  useEffect(() => {
    if (!submenuOpen) return
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        onCloseSubmenu?.()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [submenuOpen, onCloseSubmenu])

  const handleClick = () => {
    if (hasChildren) {
      onToggleSubmenu?.(item.path)
    } else {
      navigate(item.path)
    }
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={handleClick}
        aria-current={isActive && !hasChildren ? 'page' : undefined}
        aria-expanded={hasChildren ? !!submenuOpen : undefined}
        aria-haspopup={hasChildren ? 'true' : undefined}
        className={cn(
          'group relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-all duration-200',
          isActive
            ? 'text-white'
            : 'text-zinc-500 hover:bg-white/[0.03] hover:text-zinc-300'
        )}
        style={isActive ? {
          background: 'var(--accent-muted-bg)',
          boxShadow: '0 0 20px rgba(245,158,11,0.05)'
        } : undefined}
      >
        {isActive && (
          <div
            className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full"
            style={{
              background: 'linear-gradient(180deg, #fbbf24, #f59e0b)',
              boxShadow: '0 0 8px rgba(245,158,11,0.4)'
            }}
          />
        )}
        <item.icon
          className={cn(
            'h-[15px] w-[15px] shrink-0 transition-colors duration-200',
            isActive ? 'text-amber-400' : 'text-zinc-600 group-hover:text-zinc-400'
          )}
          strokeWidth={isActive ? 2 : 1.7}
          aria-hidden="true"
        />
        <span className="flex-1 text-left">{t(item.labelKey)}</span>
        {(badge || (badgeCount != null && badgeCount > 0)) && (
          <span
            className="flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-bold leading-none"
            style={{
              background: 'linear-gradient(135deg, #f59e0b, #d97706)',
              color: '#0a0600',
              boxShadow: '0 0 8px rgba(245,158,11,0.3)'
            }}
            aria-label={`${badgeCount ?? 1}`}
          >
            {badgeCount ?? 1}
          </span>
        )}
        {hasChildren && (
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 transition-all duration-200',
              submenuOpen ? 'rotate-90 text-zinc-400' : 'text-zinc-600'
            )}
            strokeWidth={1.7}
            aria-hidden="true"
          />
        )}
      </button>

      {/* Flyout submenu — rendered fixed to escape sidebar overflow */}
      {hasChildren && submenuOpen && <FlyoutMenu buttonRef={buttonRef} popoverRef={popoverRef} items={item.children!} badgeCounts={badgeCounts} onSelect={(path) => { navigate(path); onCloseSubmenu?.() }} onClose={() => { onCloseSubmenu?.(); buttonRef.current?.focus() }} />}
    </div>
  )
}

function FlyoutMenu({ buttonRef, popoverRef, items, badgeCounts, onSelect, onClose }: {
  buttonRef: React.RefObject<HTMLButtonElement | null>
  popoverRef: React.RefObject<HTMLDivElement | null>
  items: SubItemDef[]
  badgeCounts?: Record<string, number>
  onSelect: (path: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation('sidebar')
  const location = useLocation()
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useEffect(() => {
    if (!buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    // If near the bottom of the screen, open upward
    const spaceBelow = window.innerHeight - rect.top
    const menuHeight = items.length * 36 + 12 // approx
    const top = spaceBelow < menuHeight + 20 ? rect.bottom - menuHeight : rect.top
    setPos({ top, left: rect.right + 6 })
  }, [buttonRef, items.length])

  // Auto-focus first menu item on open
  useEffect(() => {
    const firstItem = popoverRef.current?.querySelector<HTMLElement>('[role="menuitem"]')
    firstItem?.focus()
  }, [popoverRef])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const menuItems = popoverRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')
    if (!menuItems?.length) return
    const currentIndex = Array.from(menuItems).indexOf(document.activeElement as HTMLElement)

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        menuItems[(currentIndex + 1) % menuItems.length].focus()
        break
      case 'ArrowUp':
        e.preventDefault()
        menuItems[(currentIndex - 1 + menuItems.length) % menuItems.length].focus()
        break
      case 'Home':
        e.preventDefault()
        menuItems[0].focus()
        break
      case 'End':
        e.preventDefault()
        menuItems[menuItems.length - 1].focus()
        break
      case 'Escape':
        e.preventDefault()
        onClose()
        break
    }
  }

  return (
    <div
      ref={popoverRef}
      className="fixed z-[200] animate-scale-in"
      style={{ top: pos.top, left: pos.left, transformOrigin: 'left top' }}
      onKeyDown={handleKeyDown}
    >
      <div
        role="menu"
        className="glass-card w-56 rounded-xl py-1.5"
        style={{
          background: 'var(--flyout-bg)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.4), inset 0 1px 0 var(--glass-inset)'
        }}
      >
        {items.map((child) => {
          const isChildActive = location.pathname === child.path
          return (
            <button
              key={child.path}
              role="menuitem"
              onClick={() => onSelect(child.path)}
              className={cn(
                'flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[12.5px] font-medium transition-all duration-150',
                isChildActive
                  ? 'text-amber-400'
                  : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'
              )}
              style={isChildActive ? { background: 'var(--accent-muted-bg)' } : undefined}
            >
              <child.icon
                className="h-[14px] w-[14px] shrink-0"
                style={{ color: isChildActive ? 'var(--accent)' : 'var(--text-muted)' }}
                strokeWidth={isChildActive ? 2 : 1.7}
                aria-hidden="true"
              />
              <span className="flex-1">{child.labelKey ? t(child.labelKey) : child.label}</span>
              {(badgeCounts?.[child.path] ?? 0) > 0 && (
                <span
                  className="flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-bold leading-none"
                  style={{
                    background: 'linear-gradient(135deg, #f59e0b, #d97706)',
                    color: '#0a0600',
                    boxShadow: '0 0 6px rgba(245,158,11,0.3)'
                  }}
                  aria-hidden="true"
                >
                  {badgeCounts![child.path]}
                </span>
              )}
              {child.badge && (
                <span
                  className="flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 text-[8px] font-bold leading-none"
                  style={{
                    background: 'linear-gradient(135deg, #f59e0b, #d97706)',
                    color: '#0a0600',
                    boxShadow: '0 0 6px rgba(245,158,11,0.3)'
                  }}
                >
                  NEW
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
