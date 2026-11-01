import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { CleanerBlocker } from '@shared/types'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'

const displayNames: Record<string, string> = {
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
  brave: 'Brave',
  firefox: 'Firefox',
  arc: 'Arc',
  chromium: 'Chromium',
  vivaldi: 'Vivaldi',
  opera: 'Opera',
  thorium: 'Thorium',
  supermium: 'Supermium',
  helium: 'Helium',
  cromite: 'Cromite',
  catsxp: 'CatsXP',
  librewolf: 'LibreWolf',
  waterfox: 'Waterfox',
  floorp: 'Floorp',
  zen: 'Zen Browser',
  'google-chrome': 'Google Chrome',
  'google-chrome-stable': 'Google Chrome',
  'chromium-browser': 'Chromium',
  'brave-browser': 'Brave',
  'vivaldi-bin': 'Vivaldi',
  'firefox-esr': 'Firefox ESR',
  'thorium-browser': 'Thorium'
}

export function useCleanAppPrompt() {
  const { t } = useTranslation('cleaner')
  const [browsers, setBrowsers] = useState<string[]>([])
  const [apps, setApps] = useState<CleanerBlocker[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const mounted = useRef(true)
  const resolveRef = useRef<((value: string[] | null) => void) | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      resolveRef.current?.(null)
    }
  }, [])
  const prepareApps = useCallback(
    async (itemIds: string[]) => {
      let running: string[]
      let blockers: CleanerBlocker[]
      try {
        ;[running, blockers] = await Promise.all([
          window.kudu.runningBrowsers(),
          window.kudu.cleanerBlockers(itemIds)
        ])
      } catch {
        toast.error(t('browserDetectionFailed'))
        return false
      }
      if (!mounted.current) return false
      const otherApps = blockers.filter((blocker) => !blocker.isBrowser)
      if (!running.length && !otherApps.length) return true
      setApps(otherApps)
      setBrowsers(running)
      setSelected([...running, ...otherApps.map((app) => `app:${app.pid}`)])
      const choice = await new Promise<string[] | null>((resolve) => {
        resolveRef.current = resolve
      })
      if (choice === null) return false
      try {
        await window.kudu.cleanerPrepareClean(choice.filter((id) => !id.startsWith('app:')))
        await window.kudu.cleanerCloseApps(
          choice.filter((id) => id.startsWith('app:')).map((id) => Number(id.slice(4)))
        )
      } catch {
        toast.error(t('browserCloseFailed'))
        return false
      }
      return true
    },
    [t]
  )
  const finish = (value: string[] | null) => {
    setBrowsers([])
    setApps([])
    resolveRef.current?.(value)
    resolveRef.current = null
  }
  const appCloseDialog = (
    <ConfirmDialog
      open={browsers.length > 0 || apps.length > 0}
      title={t('appsCloseTitle')}
      description={t('appsCloseDescription')}
      confirmLabel={t('browserCloseContinue')}
      onConfirm={() => finish(selected)}
      onCancel={() => finish(null)}
      variant="warning"
    >
      <div className="mb-5 max-h-60 overflow-y-auto space-y-2">
        {apps.map((app) => {
          const id = `app:${app.pid}`
          return (
            <label
              key={id}
              className="flex cursor-pointer items-center gap-3 rounded-lg p-2 text-sm"
              style={{ color: 'var(--text-primary)', background: 'var(--bg-subtle)' }}
            >
              <input
                type="checkbox"
                checked={selected.includes(id)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, id]
                      : current.filter((value) => value !== id)
                  )
                }
              />
              {app.name}
            </label>
          )
        })}
        {browsers.map((browser) => (
          <label
            key={browser}
            className="flex cursor-pointer items-center gap-3 rounded-lg p-2 text-sm"
            style={{ color: 'var(--text-primary)', background: 'var(--bg-subtle)' }}
          >
            <input
              type="checkbox"
              checked={selected.includes(browser)}
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked
                    ? [...current, browser]
                    : current.filter((name) => name !== browser)
                )
              }
            />
            {displayNames[browser.replace(/\.exe$/i, '').toLowerCase()] ?? browser}
          </label>
        ))}
      </div>
    </ConfirmDialog>
  )
  return { prepareApps, appCloseDialog }
}
