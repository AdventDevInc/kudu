import type { ScanHistoryEntry } from '@shared/types'
import type { CleanSummaryData } from '@/stores/scan-store'
import { formatBytes } from './utils'

export interface CleanupShareData {
  bytes: number
  items: number
  cleanups: number
  categories: { type: string; bytes: number }[]
}

const categoryTypes = new Set([
  'system',
  'browser',
  'app',
  'gaming',
  'recycleBin',
  'uninstallLeftovers',
  'shortcut',
  'database',
  'environment',
  'privacyTraces'
])
const positive = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0)

// Explicit projection: never pass paths, errors, schedule names or device details to the card.
export function shareCleanup(summary: CleanSummaryData): CleanupShareData {
  return {
    bytes: positive(summary.totalCleaned),
    items: positive(summary.filesDeleted),
    cleanups: 1,
    categories: summary.categories
      .filter((c) => categoryTypes.has(c.type) && c.space > 0)
      .map((c) => ({ type: c.type, bytes: positive(c.space) }))
  }
}

export function shareHistory(entries: ScanHistoryEntry[]): CleanupShareData {
  const cleanups = entries.filter(
    (e) => e.type === 'cleaner' && (e.totalItemsCleaned > 0 || e.totalSpaceSaved > 0)
  )
  const categories = new Map<string, number>()
  for (const entry of cleanups) {
    for (const category of entry.categories) {
      if (category.type && categoryTypes.has(category.type) && category.spaceSaved > 0) {
        categories.set(
          category.type,
          (categories.get(category.type) ?? 0) + positive(category.spaceSaved)
        )
      }
    }
  }
  return {
    bytes: cleanups.reduce((sum, e) => sum + positive(e.totalSpaceSaved), 0),
    items: cleanups.reduce((sum, e) => sum + positive(e.totalItemsCleaned), 0),
    cleanups: cleanups.length,
    // Legacy names are free text. Only stable allowlisted IDs belong on the public card.
    categories: Array.from(categories, ([type, bytes]) => ({ type, bytes }))
  }
}

export type ShareFormat = 'landscape' | 'square'
export type ShareTheme = 'dark' | 'light'

export function cleanupShareLinks(caption: string, title: string) {
  const link = (base: string, params: Record<string, string>) =>
    `${base}?${new URLSearchParams(params)}`
  return [
    { name: 'X', url: link('https://x.com/intent/tweet', { text: caption }) },
    {
      name: 'Reddit',
      url: link('https://www.reddit.com/submit', { url: 'https://usekudu.com', title })
    },
    { name: 'Bluesky', url: link('https://bsky.app/intent/compose', { text: caption }) },
    { name: 'WhatsApp', url: link('https://wa.me/', { text: caption }) },
    {
      name: 'Telegram',
      url: link('https://t.me/share/url', {
        url: 'https://usekudu.com',
        text: caption.replace('https://usekudu.com', '').trim()
      })
    }
  ]
}
type Translate = (key: string) => string
const escapeXml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!
  )

export function cleanupCardSvg(
  data: CleanupShareData,
  theme: ShareTheme,
  format: ShareFormat,
  breakdown: boolean,
  t: Translate
): string {
  const height = format === 'square' ? 1080 : 675
  const dark = theme === 'dark'
  const ink = dark ? '#f4f4f5' : '#18181b'
  const muted = dark ? '#a1a1aa' : '#62626c'
  const panel = dark ? '#202125' : '#f2f2ee'
  const accent = dark ? '#fbbf24' : '#a65d00'
  const text = (x: number, y: number, size: number, value: string, color = ink, weight = 400) =>
    `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-weight="${weight}">${escapeXml(value)}</text>`
  const rows = breakdown ? [...data.categories].sort((a, b) => b.bytes - a.bytes).slice(0, 4) : []
  const remaining = breakdown
    ? data.categories.reduce((s, c) => s + c.bytes, 0) - rows.reduce((s, c) => s + c.bytes, 0)
    : 0
  if (remaining > 0) rows.push({ type: 'other', bytes: remaining })
  const max = Math.max(...rows.map((c) => c.bytes), 1)
  const heroY = format === 'square' ? 300 : 240
  const barsY = format === 'square' ? 580 : 410
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${height}" viewBox="0 0 1080 ${height}">
  <defs><radialGradient id="glow"><stop stop-color="#f59e0b" stop-opacity=".18"/><stop offset="1" stop-color="#f59e0b" stop-opacity="0"/></radialGradient></defs>
  <rect width="1080" height="${height}" rx="32" fill="${dark ? '#141518' : '#fafaf7'}"/>
  <circle cx="970" cy="100" r="390" fill="url(#glow)"/>
  <g font-family="Arial, sans-serif">
  <rect x="56" y="52" width="48" height="48" rx="14" fill="#f59e0b"/>
  ${text(67, 87, 32, 'k', '#18181b', 700)}${text(119, 88, 32, 'kudu', ink, 700)}
  ${text(56, 150, 18, t(data.cleanups > 1 ? 'share.historyEyebrow' : 'share.cleanupEyebrow'), muted)}
  ${text(56, heroY, 76, formatBytes(data.bytes, 1), accent, 700)}
  ${text(59, heroY + 43, 22, t('share.recovered'), muted)}
  <rect x="56" y="${heroY + 80}" width="968" height="90" rx="20" fill="${panel}"/>
  ${text(82, heroY + 118, 28, data.items.toLocaleString(), ink, 700)}
  ${text(82, heroY + 147, 17, t('share.items'), muted)}
  ${text(574, heroY + 118, 28, data.cleanups.toLocaleString(), ink, 700)}
  ${text(574, heroY + 147, 17, t('share.cleanups'), muted)}
  ${rows
    .map((c, i) => {
      const y = barsY + i * 35
      return `${text(56, y + 18, 16, t('share.categories.' + c.type), muted)}<rect x="300" y="${y + 6}" width="530" height="10" rx="5" fill="${panel}"/><rect x="300" y="${y + 6}" width="${Math.max(3, (c.bytes / max) * 530)}" height="10" rx="5" fill="#f59e0b"/>${text(858, y + 18, 16, formatBytes(c.bytes, 1), muted)}`
    })
    .join('')}
  ${rows.length === 0 ? text(56, barsY + 38, 26, t('share.tagline'), ink, 500) : ''}
  <path d="M56 ${height - 100}H1024" stroke="${dark ? '#343438' : '#ddddda'}"/>
  ${text(56, height - 52, 17, t('share.footer'), muted)}
  ${text(850, height - 52, 22, 'usekudu.com', accent, 700)}
  </g></svg>`
}

export async function cardPng(svg: string, height: number): Promise<Blob> {
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = 1080
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.drawImage(img, 0, 0)
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG export failed'))),
      'image/png'
    )
  )
}
