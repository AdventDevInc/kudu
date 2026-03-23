import { useCallback } from 'react'
import { Sidebar } from './Sidebar'
import { AdminBanner } from './AdminBanner'

export function AppShell({ children }: { children: React.ReactNode }) {
  const handleSkip = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault()
    const el = document.getElementById('main-content')
    if (el) { el.focus(); el.scrollIntoView() }
  }, [])

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#0a0a10' }}>
      <a href="#" className="skip-nav" onClick={handleSkip}>Skip to main content</a>
      <Sidebar />
      <div className="relative flex flex-1 flex-col overflow-hidden">
        {/* Ambient background glow */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div
            className="absolute -top-[100px] left-[80px] h-[500px] w-[500px] rounded-full blur-[180px]"
            style={{ background: 'rgba(245,158,11,0.025)' }}
          />
          <div
            className="absolute bottom-[0] right-[40px] h-[400px] w-[400px] rounded-full blur-[160px]"
            style={{ background: 'rgba(59,130,246,0.02)' }}
          />
        </div>

        {/* Invisible drag region for moving window (top edge) */}
        <div className="drag-region h-8 shrink-0" />
        {/* Window controls float in top right */}
        <WindowControls />
        <AdminBanner />
        <main id="main-content" tabIndex={-1} className="relative flex-1 overflow-y-auto px-10 pb-10 pt-2 outline-none">
          {children}
        </main>
      </div>
    </div>
  )
}

function WindowControls() {
  return (
    <div className="no-drag fixed right-0 top-0 z-50 flex" role="toolbar" aria-label="Window controls">
      <button
        onClick={() => window.kudu.windowMinimize()}
        aria-label="Minimize window"
        className="flex h-8 w-12 items-center justify-center text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
      >
        <svg width="10" height="1" viewBox="0 0 10 1" aria-hidden="true"><rect width="10" height="1" fill="currentColor" /></svg>
      </button>
      <button
        onClick={() => window.kudu.windowMaximize()}
        aria-label="Maximize window"
        className="flex h-8 w-12 items-center justify-center text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" /></svg>
      </button>
      <button
        onClick={() => window.kudu.windowClose()}
        aria-label="Close window"
        className="flex h-8 w-12 items-center justify-center text-zinc-500 transition-colors hover:bg-red-500 hover:text-white"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.2" /></svg>
      </button>
    </div>
  )
}
