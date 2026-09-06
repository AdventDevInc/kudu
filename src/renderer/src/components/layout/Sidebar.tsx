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
  MousePointerClick,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'
import { useThreatMonitorStore } from '@/stores/threat-monitor-store'
import { useAppUpdateStore } from '@/stores/app-update-store'
import { useUpdaterStore } from '@/stores/updater-store'
import { useDriverStore } from '@/stores/driver-store'
import { useGameModeStore } from '@/stores/game-mode-store'
import { useCveStore } from '@/stores/cve-store'
import { useBreachStore } from '@/stores/breach-store'
import { usePlatform } from '@/hooks/usePlatform'
import { useSettingsStore } from '@/stores/settings-store'

interface SubItemDef {
  icon: LucideIcon
  label?: string
  labelKey?: string
  path: string
  badge?: boolean
  cloudTier?: 'basic' | 'pro'
}

interface NavItemDef {
  icon: LucideIcon
  labelKey?: string
  label?: string
  path: string
  children?: SubItemDef[]
}

interface NavGroup {
  headingKey?: string
  heading?: string
  items: NavItemDef[]
}

const navGroups: NavGroup[] = [
  {
    items: [
      { icon: LayoutDashboard, labelKey: 'dashboard', label: 'Home', path: '/' },
      {
        icon: Sparkles, labelKey: 'cleaner', label: 'Clean up', path: '/cleaner',
        children: [
          { icon: Sparkles, labelKey: 'cleaner:pageTitle', label: 'System Cleaner', path: '/cleaner' },
          { icon: Database, labelKey: 'registry:pageTitle', label: 'Registry', path: '/registry' },
          { icon: Zap, labelKey: 'startup:pageTitle', label: 'Startup', path: '/startup' },
          { icon: Wifi, labelKey: 'network:pageTitle', label: 'Network', path: '/network' },
          { icon: CalendarClock, labelKey: 'schedules:pageTitle', label: 'Automatic Care', path: '/schedules' },
        ]
      },
      {
        icon: Shield, labelKey: 'securityHeading', label: 'Protection', path: '/malware',
        children: [
          { icon: ShieldAlert, labelKey: 'malware:pageTitle', label: 'Malware Scanner', path: '/malware' },
          { icon: Eye, labelKey: 'hardening:privacy.pageTitle', label: 'Privacy', path: '/privacy' },
          { icon: Radar, labelKey: 'threatMonitor:pageTitle', label: 'Threat Monitor', path: '/threat-monitor', cloudTier: 'pro' },
          { icon: Flame, labelKey: 'firewallAudit', label: 'Firewall Audit', path: '/firewall' },
          { icon: Bug, labelKey: 'cveScanner:pageTitle', label: 'Vulnerability Scanner', path: '/cve', cloudTier: 'pro' },
          { icon: Mail, labelKey: 'breachMonitor:pageTitle', label: 'Breach Monitor', path: '/breach-monitor', cloudTier: 'basic' },
        ]
      },
      {
        icon: Activity, labelKey: 'performance', label: 'Performance', path: '/performance',
        children: [
          { icon: Activity, labelKey: 'performance:pageTitle', label: 'Live Performance', path: '/performance' },
          { icon: Server, labelKey: 'hardening:serviceManager.pageTitle', label: 'Services', path: '/services' },
        ]
      },
    ]
  },
  {
    headingKey: 'maintainHeading',
    items: [
      {
        icon: Package, labelKey: 'software', label: 'Software', path: '/software',
        children: [
          { icon: Download, labelKey: 'updates:softwareUpdater.pageTitle', label: 'Software Updates', path: '/updates' },
          { icon: Cpu, labelKey: 'updates:driverManager.pageTitle', label: 'Driver Updates', path: '/drivers' },
          { icon: Trash2, labelKey: 'uninstaller:pageTitle', label: 'Uninstaller', path: '/uninstaller' },
          { icon: PackageMinus, labelKey: 'hardening:debloater.pageTitle', label: 'Bloatware Remover', path: '/debloater' },
          { icon: MousePointerClick, labelKey: 'contextMenu:pageTitle', label: 'Context Menu', path: '/context-menu' },
        ]
      },
      {
        icon: HardDrive, labelKey: 'diskTools', label: 'Storage', path: '/disk',
        children: [
          { icon: HardDrive, labelKey: 'disk:pageTitle', label: 'Storage Overview', path: '/disk' },
          { icon: CopyCheck, labelKey: 'duplicates:pageTitle', label: 'Duplicate Finder', path: '/duplicates' },
          { icon: FileUp, labelKey: 'largeFiles:pageTitle', label: 'Large File Finder', path: '/large-files' },
          { icon: FolderX, labelKey: 'emptyFolders:pageTitle', label: 'Empty Folder Cleaner', path: '/empty-folders' },
          { icon: ShieldAlertIcon, labelKey: 'fileShredder:pageTitle', label: 'File Shredder', path: '/file-shredder' },
          { icon: Wrench, labelKey: 'disk:repairTitle', label: 'Disk Repair', path: '/disk-repair' },
          { icon: Eraser, labelKey: 'disk:maintenanceTitle', label: 'Disk Maintenance', path: '/disk-maintenance' },
        ]
      },
      { icon: Gamepad2, labelKey: 'gameMode', label: 'Game Mode', path: '/game-mode' },
      { icon: History, labelKey: 'history', label: 'Activity', path: '/history' },
    ]
  }
]

function useBottomNavItems(): NavItemDef[] {
  const updateState = useAppUpdateStore((s) => s.status.state)
  const showUpdateBadge = updateState === 'available' || updateState === 'downloaded'

  return [
    {
      icon: Settings, labelKey: 'settings', label: 'Preferences', path: '/settings',
      children: [
        { icon: Settings, labelKey: 'settings:pageTitle', label: 'Preferences', path: '/settings' },
        { icon: Cloud, labelKey: 'cloud:pageTitle', label: 'Cloud', path: '/cloud' },
        { icon: Info, labelKey: 'settings:sectionAbout', label: 'About & Updates', path: '/about', badge: showUpdateBadge },
      ]
    }
  ]
}

// Map nav paths to badge counts from stores
function useBadgeCounts(): Record<string, number> {
  const softwareUpdaterNotifications = useSettingsStore(
    (s) => s.settings.softwareUpdaterNotifications ?? true
  )
  const updaterApps = useUpdaterStore((s) => s.apps)
  const driverUpdates = useDriverStore((s) => s.updates)
  const threatSnapshot = useThreatMonitorStore((s) => s.snapshot)
  const threatCount = (threatSnapshot?.flaggedConnections.length ?? 0) + (threatSnapshot?.flaggedDns.length ?? 0)
  const gameModeActive = useGameModeStore((s) => s.active)
  const cveTotal = useCveStore((s) => s.total)
  const breachEmails = useBreachStore((s) => s.emails)
  const breachTotal = breachEmails.reduce((sum, e) => sum + e.breaches.filter((b) => !b.acknowledgedAt).length, 0)

  const softwareUpdateCount = softwareUpdaterNotifications ? updaterApps.length : 0
  const updatesCount = softwareUpdateCount + driverUpdates.length

  return {
    '/updates': softwareUpdateCount,
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
  const navigate = useNavigate()
  const badgeCounts = useBadgeCounts()
  const { features } = usePlatform()
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null)

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
        if (child.path === '/registry' && !features.registry) return false
        if (child.path === '/debloater' && !features.debloater) return false
        if (child.path === '/drivers' && !features.drivers) return false
        if (child.path === '/context-menu' && !features.contextMenu) return false
        if (child.path === '/firewall' && !features.firewallAudit) return false
        return true
      })
      return { ...item, children: filtered }
    }).filter((item) => {
      if (item.children && item.children.length === 0) return false
      return true
    }),
  }))

  useEffect(() => {
    const activeParent = navGroups
      .flatMap((group) => group.items)
      .find((item) => item.children?.some((child) => child.path === location.pathname))
    if (activeParent) setOpenSubmenu(activeParent.path)
    else if (['/settings', '/cloud', '/about'].includes(location.pathname)) setOpenSubmenu('/settings')
  }, [location.pathname])

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
      className="kudu-sidebar flex h-full w-[214px] shrink-0 flex-col"
      style={{
        background: 'var(--sidebar-bg)',
        borderRight: '1px solid var(--border-medium)'
      }}
    >
      {/* Logo — doubles as drag region */}
      {/* Nav items */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-2 pt-4" aria-label={t('mainNavigation', 'Main navigation')}>
        {filteredNavGroups.map((group, gi) => (
          <div key={gi} className={gi > 0 ? 'mt-5' : ''} role={group.headingKey || group.heading ? 'group' : undefined} aria-labelledby={group.headingKey || group.heading ? `nav-group-${gi}` : undefined}>
            {(group.headingKey || group.heading) && (
              <div className="mb-2 flex items-center gap-2.5 px-3 pt-0.5">
                <span
                  id={`nav-group-${gi}`}
                  className="text-[10px] font-semibold uppercase tracking-[0.15em]"
                  style={{ color: 'var(--text-faint)' }}
                >
                  {group.heading ?? (group.headingKey ? t(group.headingKey) : '')}
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

      <button
        type="button"
        onClick={() => navigate('/schedules')}
        className="automatic-care-card mx-3 mb-2 text-left"
      >
        <span className="automatic-care-icon"><CalendarClock className="h-3.5 w-3.5" strokeWidth={1.8} /></span>
        <span className="min-w-0">
          <b>{t('schedules:pageTitle')}</b>
          <small>{t('schedules:pageDescription')}</small>
        </span>
      </button>

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
  const itemLabel = item.labelKey ? t(item.labelKey, { defaultValue: item.label ?? '' }) : (item.label ?? '')
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [isCompact, setIsCompact] = useState(() => window.matchMedia('(max-width: 980px)').matches)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 980px)')
    const update = () => setIsCompact(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

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
        className={cn(
          'calm-nav-item group relative flex w-full items-center gap-3 rounded-[14px] px-3.5 py-2.5 text-[12px] font-semibold transition-all duration-200'
        )}
        style={isActive ? {
          background: 'var(--nav-active-bg)',
          color: 'var(--nav-active-fg)',
          boxShadow: '0 6px 18px rgba(11,40,31,.12)'
        } : { color: 'var(--nav-inactive-fg)' }}
      >
        {isActive && (
          <div
            className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full"
            style={{
              background: 'var(--accent)',
              boxShadow: 'none'
            }}
          />
        )}
        <item.icon
          className={cn(
            'h-[17px] w-[17px] shrink-0 transition-colors duration-200',
            isActive ? '' : 'group-hover:text-zinc-400'
          )}
          style={{ color: isActive ? 'var(--nav-active-fg)' : 'var(--nav-icon-fg)' }}
          strokeWidth={isActive ? 2 : 1.8}
          aria-hidden="true"
        />
        <span className="flex-1 text-left">{itemLabel}</span>
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
              submenuOpen ? 'rotate-90' : ''
            )}
            style={{ color: isActive ? 'var(--nav-active-fg)' : 'var(--nav-icon-fg)' }}
            strokeWidth={1.7}
            aria-hidden="true"
          />
        )}
      </button>

      {/* Flyout submenu — rendered fixed to escape sidebar overflow */}
      {hasChildren && submenuOpen && !isCompact && (
        <div className="sidebar-submenu animate-fade-in" role="group" aria-label={`${itemLabel} tools`}>
          {item.children!.map((child) => {
            const isChildActive = location.pathname === child.path
            const childLabel = child.labelKey ? t(child.labelKey, { defaultValue: child.label ?? '' }) : (child.label ?? '')
            return (
              <button
                key={child.path}
                type="button"
                onClick={() => navigate(child.path)}
                aria-current={isChildActive ? 'page' : undefined}
                title={childLabel}
                className="sidebar-submenu-item"
                style={{
                  background: isChildActive ? 'var(--brand-surface)' : 'transparent',
                  color: isChildActive ? 'var(--brand-solid)' : 'var(--text-secondary)'
                }}
              >
                <child.icon aria-hidden="true" strokeWidth={isChildActive ? 2.1 : 1.7} />
                <span>{childLabel}</span>
                {(badgeCounts?.[child.path] ?? 0) > 0 && (
                  <b aria-label={`${badgeCounts![child.path]} items`}>{badgeCounts![child.path]}</b>
                )}
                {child.cloudTier && <CloudTierBadge tier={child.cloudTier} />}
                {child.badge && <b>NEW</b>}
              </button>
            )
          })}
        </div>
      )}
      {hasChildren && submenuOpen && isCompact && (
        <FlyoutMenu
          buttonRef={buttonRef}
          popoverRef={popoverRef}
          items={item.children!}
          badgeCounts={badgeCounts}
          onSelect={(path) => {
            navigate(path)
            onCloseSubmenu?.()
          }}
          onClose={() => {
            onCloseSubmenu?.()
            buttonRef.current?.focus()
          }}
        />
      )}
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
          const childLabel = child.labelKey ? t(child.labelKey, { defaultValue: child.label ?? '' }) : (child.label ?? '')
          return (
            <button
              key={child.path}
              role="menuitem"
              onClick={() => onSelect(child.path)}
              className={cn(
                'flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[12.5px] font-medium transition-all duration-150',
                'hover:bg-white/[0.04]'
              )}
              style={{
                background: isChildActive ? 'var(--brand-surface)' : undefined,
                color: isChildActive ? 'var(--brand-solid)' : 'var(--text-secondary)'
              }}
            >
              <child.icon
                className="h-[14px] w-[14px] shrink-0"
                style={{ color: isChildActive ? 'var(--brand-solid)' : 'var(--text-muted)' }}
                strokeWidth={isChildActive ? 2 : 1.7}
                aria-hidden="true"
              />
              <span className="flex-1">{childLabel}</span>
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
              {child.cloudTier && <CloudTierBadge tier={child.cloudTier} />}
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

function CloudTierBadge({ tier }: { tier: 'basic' | 'pro' }) {
  const { t } = useTranslation('cloud')
  const label = tier === 'pro' ? t('planProName') : t('planBasicName')
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider"
      style={{
        background: tier === 'pro' ? 'var(--accent-muted-bg)' : 'color-mix(in srgb, var(--info), transparent 89%)',
        border: `1px solid ${tier === 'pro' ? 'var(--accent-muted-border)' : 'color-mix(in srgb, var(--info), transparent 72%)'}`,
        color: tier === 'pro' ? 'var(--warning)' : 'var(--info)',
      }}
      aria-label={t('pageTitle') + ' ' + label}
    >
      {label}
    </span>
  )
}
