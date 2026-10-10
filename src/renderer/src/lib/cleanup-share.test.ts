import { describe, expect, it } from 'vitest'
import { cleanupCardSvg, cleanupShareLinks, shareCleanup, shareHistory } from './cleanup-share'
import type { CleanSummaryData } from '@/stores/scan-store'
import type { ScanHistoryEntry } from '@shared/types'

describe('cleanup share privacy projection', () => {
  it('encodes captions and titles without introducing extra query parameters', () => {
    const caption = 'Recovered 2 GB & more #Kudu + friends? https://usekudu.com'
    const title = 'Kudu & friends'
    const links = cleanupShareLinks(caption, title)
    for (const platform of links) {
      const url = new URL(platform.url)
      expect(url.protocol).toBe('https:')
      if (platform.name === 'Reddit') {
        expect(url.searchParams.get('title')).toBe(title)
        expect(url.searchParams.get('url')).toBe('https://usekudu.com')
      } else if (platform.name === 'Telegram') {
        expect(url.searchParams.get('text')).toBe(caption.replace('https://usekudu.com', '').trim())
        expect(url.searchParams.get('url')).toBe('https://usekudu.com')
      } else {
        expect(url.searchParams.get('text')).toBe(caption)
        expect([...url.searchParams.keys()]).toEqual(['text'])
      }
    }
  })
  const summary: CleanSummaryData = {
    totalCleaned: 1024,
    filesDeleted: 4,
    filesSkipped: 2,
    errors: [{ path: 'C:/Users/Private/secret.txt', reason: 'locked' }],
    needsElevation: false,
    duration: 100,
    totalSizeBefore: 2048,
    categories: [
      { name: 'Private app name', type: 'app', found: 4, cleaned: 4, space: 1024 },
      { name: 'Secret', type: 'C:/Users/Private', found: 1, cleaned: 1, space: 100 }
    ]
  }
  it('only exposes aggregate results and allowlisted category IDs', () => {
    expect(shareCleanup(summary)).toEqual({
      bytes: 1024,
      items: 4,
      cleanups: 1,
      categories: [{ type: 'app', bytes: 1024 }]
    })
    expect(JSON.stringify(shareCleanup(summary))).not.toMatch(/Private|secret|locked/)
  })
  it('excludes unrelated actions and scan-only runs from cleanup history', () => {
    const entry: ScanHistoryEntry = {
      id: 'private-id',
      type: 'cleaner',
      timestamp: '2026-01-01',
      duration: 100,
      totalItemsFound: 10,
      totalItemsCleaned: 4,
      totalItemsSkipped: 0,
      totalSpaceSaved: 1024,
      categories: [{ name: 'private-path', itemsFound: 10, itemsCleaned: 4, spaceSaved: 1024 }],
      errorCount: 1,
      scheduleName: 'Private computer'
    }
    expect(
      shareHistory([
        entry,
        { ...entry, type: 'registry' },
        { ...entry, totalItemsCleaned: 0, totalSpaceSaved: 0 }
      ])
    ).toEqual({ bytes: 1024, items: 4, cleanups: 1, categories: [] })
  })
  it('escapes localized text and renders both image sizes without private metadata', () => {
    for (const format of ['landscape', 'square'] as const) {
      const svg = cleanupCardSvg(shareCleanup(summary), 'dark', format, true, () => '<script>&"')
      expect(svg).toContain(format === 'square' ? 'height="1080"' : 'height="675"')
      expect(svg).toContain('&lt;script&gt;&amp;&quot;')
      expect(svg).not.toMatch(/Private|secret|locked|<script>/)
    }
  })
  it('never renders breakdown rows when disabled', () => {
    expect(
      cleanupCardSvg(shareCleanup(summary), 'light', 'landscape', false, (key) => key)
    ).not.toContain('share.categories.app')
  })
  it('aggregates only stable category IDs from new history', () => {
    const entry = {
      type: 'cleaner',
      totalItemsCleaned: 4,
      totalSpaceSaved: 1024,
      categories: [
        { type: 'app', name: 'Private name', spaceSaved: 1024 },
        { type: 'Private ID', name: 'Secret', spaceSaved: 10 }
      ]
    } as ScanHistoryEntry
    expect(shareHistory([entry, entry]).categories).toEqual([{ type: 'app', bytes: 2048 }])
  })
})
