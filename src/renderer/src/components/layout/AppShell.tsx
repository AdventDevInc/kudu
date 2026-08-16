import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { AdminBanner } from './AdminBanner'
import { useSettingsStore } from '@/stores/settings-store'
import { usePlatform } from '@/hooks/usePlatform'
import logoSrc from '@/assets/logo.png'

export function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const { platform } = usePlatform()
  const handleSkip = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault()
    const el = document.getElementById('main-content')
    if (el) { el.focus(); el.scrollIntoView() }
  }, [])

  return (
    <div className="app-shell h-screen overflow-hidden" data-platform={platform}>
      <a href="#" className="skip-nav" onClick={handleSkip}>Skip to main content</a>

      <header className="app-titlebar drag-region" aria-label="Kudu window titlebar">
        <div className="app-brand">
          <img src={logoSrc} alt="" className="h-6 w-6 rounded-[8px]" />
          <div>
            <div className="text-[12px] font-bold leading-none" style={{ color: 'var(--text-primary)' }}>Kudu</div>
          </div>
        </div>
        <div className="app-titlebar-drag flex-1" aria-hidden="true" />
        <div className="app-titlebar-actions no-drag flex h-full items-center">
          <AppearanceMenu />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <AdminBanner />
          <main id="main-content" data-route={location.pathname} tabIndex={-1} className="app-content relative flex-1 overflow-y-auto outline-none">
            {children}
          </main>
        </div>
      </div>
    </div>
  )
}

type ThemeMode = 'system' | 'light' | 'dark'

function AppearanceMenu() {
  const theme = useSettingsStore((s) => s.settings.theme)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const options: { id: ThemeMode; label: string; description: string; icon: typeof Sun }[] = [
    { id: 'system', label: 'System', description: 'Follow your computer', icon: Monitor },
    { id: 'light', label: 'Light', description: 'Warm daylight', icon: Sun },
    { id: 'dark', label: 'Dark', description: 'Low-light comfort', icon: Moon },
  ]
  const active = options.find((option) => option.id === theme) ?? options[0]
  const ActiveIcon = active.icon

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])

  const selectTheme = (nextTheme: ThemeMode) => {
    updateSettings({ theme: nextTheme })
    window.kudu?.settingsSet?.({ theme: nextTheme }).catch(() => {})
    setOpen(false)
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        className="titlebar-icon-button"
        aria-label={`Appearance: ${active.label}`}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`Appearance: ${active.label}`}
        onClick={() => setOpen((value) => !value)}
      >
        <ActiveIcon className="h-3.5 w-3.5" strokeWidth={1.8} />
      </button>
      {open && (
        <div className="appearance-menu animate-scale-in" role="menu" aria-label="Appearance">
          <div className="px-3 pb-2 pt-2.5 text-[9px] font-bold uppercase tracking-[0.16em]" style={{ color: 'var(--text-dim)' }}>Appearance</div>
          {options.map((option) => {
            const Icon = option.icon
            const selected = option.id === theme
            return (
              <button key={option.id} type="button" role="menuitemradio" aria-checked={selected} onClick={() => selectTheme(option.id)}>
                <span className="appearance-option-icon"><Icon className="h-4 w-4" strokeWidth={1.8} /></span>
                <span className="min-w-0 flex-1 text-left">
                  <b>{option.label}</b>
                  <small>{option.description}</small>
                </span>
                {selected && <Check className="h-3.5 w-3.5" style={{ color: 'var(--brand-solid)' }} strokeWidth={2.4} />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
