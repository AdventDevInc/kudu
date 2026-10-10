import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Copy, Download, Share2, X } from 'lucide-react'
import { toast } from 'sonner'
import { formatBytes } from '@/lib/utils'
import {
  cardPng,
  cleanupCardSvg,
  cleanupShareLinks,
  type CleanupShareData,
  type ShareFormat,
  type ShareTheme
} from '@/lib/cleanup-share'

export function ShareCleanup({ data }: { data: CleanupShareData }) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        className="feature-button"
        onClick={() => setOpen(true)}
        disabled={data.cleanups === 0 || (data.items === 0 && data.bytes === 0)}
      >
        <Share2 size={15} aria-hidden="true" />
        {t('share.button')}
      </button>
      {open &&
        createPortal(<ShareDesigner data={data} onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

function ShareDesigner({ data, onClose }: { data: CleanupShareData; onClose: () => void }) {
  const { t } = useTranslation('common')
  const titleId = useId()
  const descriptionId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const [theme, setTheme] = useState<ShareTheme>('dark')
  const [format, setFormat] = useState<ShareFormat>('landscape')
  const [breakdown, setBreakdown] = useState(true)
  const [busy, setBusy] = useState(false)
  const svg = cleanupCardSvg(data, theme, format, breakdown, (key) => t(key))
  const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  const caption = t('share.caption', {
    space: formatBytes(data.bytes, 1),
    items: data.items.toLocaleString(),
    cleanups: data.cleanups
  })

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => previous?.focus()
  }, [])

  const exportCard = async (action: 'save' | 'copy' | 'share' | 'discord') => {
    setBusy(true)
    try {
      const blob = await cardPng(svg, format === 'square' ? 1080 : 675)
      if (action === 'copy' || action === 'discord') {
        await navigator.clipboard.write([
          new ClipboardItem({
            'image/png': blob,
            ...(action === 'discord'
              ? { 'text/plain': new Blob([caption], { type: 'text/plain' }) }
              : {})
          })
        ])
        toast.success(t(action === 'discord' ? 'share.discordCopied' : 'share.copied'))
      } else if (action === 'share') {
        const file = new File([blob], 'kudu-cleanup.png', { type: 'image/png' })
        await navigator.share({ files: [file], text: caption })
      } else {
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = 'kudu-cleanup.png'
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        toast.error(t('share.exportError'))
    } finally {
      setBusy(false)
    }
  }
  const nativeShare =
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [new File([''], 'kudu-cleanup.png', { type: 'image/png' })] })

  return (
    <dialog
      ref={dialog}
      onCancel={onClose}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="m-auto w-[min(900px,calc(100vw-32px))] max-h-[90vh] overflow-y-auto rounded-2xl p-6 backdrop:bg-black/70"
      style={{
        background: 'var(--card-bg)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border-medium)'
      }}
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 id={titleId} className="text-xl font-semibold">
            {t('share.title')}
          </h2>
          <p id={descriptionId} className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            {t('share.description')}
          </p>
        </div>
        <button onClick={onClose} aria-label={t('share.close')} className="feature-button">
          <X size={18} />
        </button>
      </div>
      <div
        className="mb-4 rounded-xl p-4"
        style={{
          background: 'var(--accent-muted-bg)',
          border: '1px solid var(--accent-muted-border)'
        }}
      >
        <h3 className="text-sm font-semibold">{t('share.communityTitle')}</h3>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {t('share.communityDescription')}
        </p>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-4 text-sm">
        <label>
          {t('share.theme')}{' '}
          <select
            className="rounded-lg p-2"
            style={{ background: 'var(--bg-subtle)' }}
            value={theme}
            onChange={(e) => setTheme(e.target.value as ShareTheme)}
            disabled={busy}
          >
            <option value="dark">{t('share.dark')}</option>
            <option value="light">{t('share.light')}</option>
          </select>
        </label>
        <label>
          {t('share.format')}{' '}
          <select
            className="rounded-lg p-2"
            style={{ background: 'var(--bg-subtle)' }}
            value={format}
            onChange={(e) => setFormat(e.target.value as ShareFormat)}
            disabled={busy}
          >
            <option value="landscape">{t('share.landscape')}</option>
            <option value="square">{t('share.square')}</option>
          </select>
        </label>
        {data.categories.length > 0 && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={breakdown}
              onChange={(e) => setBreakdown(e.target.checked)}
              disabled={busy}
            />
            {t('share.breakdown')}
          </label>
        )}
      </div>
      <div
        className="flex justify-center rounded-xl p-3"
        style={{ background: 'var(--bg-subtle)' }}
      >
        <img
          src={src}
          alt={caption}
          className="block w-full rounded-xl"
          style={{ maxWidth: format === 'square' ? 460 : undefined }}
        />
      </div>
      <p className="my-3 text-xs" style={{ color: 'var(--text-muted)' }}>
        {t('share.privacy')}
      </p>
      <div className="flex flex-wrap gap-2">
        <button className="feature-button" disabled={busy} onClick={() => void exportCard('save')}>
          <Download size={15} />
          {t('share.save')}
        </button>
        {typeof ClipboardItem !== 'undefined' &&
          typeof navigator.clipboard?.write === 'function' && (
            <button
              className="feature-button"
              disabled={busy}
              onClick={() => void exportCard('copy')}
            >
              <Copy size={15} />
              {t('share.copyImage')}
            </button>
          )}
        <button
          className="feature-button"
          disabled={busy}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(caption)
              toast.success(t('share.copied'))
            } catch {
              toast.error(t('share.copyError'))
            }
          }}
        >
          <Copy size={15} />
          {t('share.copyCaption')}
        </button>
        {nativeShare && (
          <button
            className="feature-button"
            disabled={busy}
            onClick={() => void exportCard('share')}
          >
            <Share2 size={15} />
            {t('share.share')}
          </button>
        )}
      </div>
      <div className="mt-4 flex flex-wrap gap-2" aria-label={t('share.platforms')}>
        {cleanupShareLinks(
          caption,
          t('share.postTitle', { space: formatBytes(data.bytes, 1) })
        ).map((platform) => (
          <a
            key={platform.name}
            className="feature-button"
            href={platform.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('share.openPlatform', { platform: platform.name })}
          >
            <Share2 size={15} aria-hidden="true" />
            {platform.name}
          </a>
        ))}
        {typeof ClipboardItem !== 'undefined' &&
          typeof navigator.clipboard?.write === 'function' && (
            <button
              className="feature-button"
              disabled={busy}
              onClick={() => void exportCard('discord')}
            >
              <Copy size={15} />
              {t('share.discord')}
            </button>
          )}
      </div>
      <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
        {t('share.destinations')}
      </p>
    </dialog>
  )
}
