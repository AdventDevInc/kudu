import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ScanItem } from '../../shared/types'
import {
  collectBlockerCandidateFiles,
  parseRestartManagerBlockers,
} from './cleaner-blockers'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('parseRestartManagerBlockers', () => {
  it('deduplicates app processes and gives browsers friendly names', () => {
    const result = parseRestartManagerBlockers(JSON.stringify([
      { pid: 10, name: 'Google Chrome', processName: 'chrome', executablePath: 'C:\\Chrome\\chrome.exe' },
      { pid: 11, name: 'Google Chrome', processName: 'chrome', executablePath: 'C:\\Chrome\\chrome.exe' },
      { pid: 20, name: 'Slack', processName: 'slack', executablePath: 'C:\\Slack\\slack.exe' },
    ]), 'C:\\Program Files\\Kudu\\Kudu.exe')

    expect(result).toEqual([
      { pid: 10, name: 'Google Chrome', processName: 'chrome', isBrowser: true },
      { pid: 20, name: 'Slack', processName: 'slack', isBrowser: false },
    ])
  })

  it('omits Kudu processes because they cannot be closed from the cleaner UI', () => {
    const result = parseRestartManagerBlockers(JSON.stringify([
      { pid: 30, name: 'Kudu', processName: 'Kudu', executablePath: 'C:\\Program Files\\Kudu\\Kudu.exe' },
      { pid: 31, name: 'Kudu', processName: 'Kudu', executablePath: '' },
      { pid: 32, name: 'Firefox', processName: 'firefox', executablePath: 'C:\\Firefox\\firefox.exe' },
    ]), 'C:\\Program Files\\Kudu\\Kudu.exe')

    expect(result).toEqual([
      { pid: 32, name: 'Firefox', processName: 'firefox', isBrowser: true },
    ])
  })

  it('treats malformed advisory output as no blockers', () => {
    expect(parseRestartManagerBlockers('not-json')).toEqual([])
    expect(parseRestartManagerBlockers('')).toEqual([])
  })
})

describe('collectBlockerCandidateFiles', () => {
  it('expands selected directories to files without following links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kudu-blocker-test-'))
    tempDirs.push(root)
    const selected = join(root, 'selected')
    const outside = join(root, 'outside')
    await mkdir(join(selected, 'nested'), { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(selected, 'cache.data'), 'cache')
    await writeFile(join(selected, 'nested', 'index'), 'index')
    await writeFile(join(outside, 'private.data'), 'private')
    try {
      await symlink(outside, join(selected, 'linked-outside'), 'junction')
    } catch {
      // Creating a link can require extra privileges on older Windows hosts.
    }

    const item: ScanItem = {
      id: 'selected-cache',
      path: selected,
      size: 10,
      category: 'browser',
      subcategory: 'Chrome Cache',
      lastModified: 0,
      selected: true,
    }
    const result = await collectBlockerCandidateFiles([item], 10)

    expect(result).toContain(join(selected, 'cache.data'))
    expect(result).toContain(join(selected, 'nested', 'index'))
    expect(result).not.toContain(join(outside, 'private.data'))
  })

  it('keeps the preflight bounded and spreads candidates across subcategories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kudu-blocker-test-'))
    tempDirs.push(root)
    const items: ScanItem[] = []
    for (let index = 0; index < 10; index++) {
      const path = join(root, `cache-${index}.data`)
      await writeFile(path, String(index))
      items.push({
        id: `item-${index}`,
        path,
        size: index + 1,
        category: 'browser',
        subcategory: index < 5 ? 'Chrome Cache' : 'Firefox Cache',
        lastModified: 0,
        selected: true,
      })
    }

    const result = await collectBlockerCandidateFiles(items, 4)

    expect(result).toHaveLength(4)
    expect(result.some((path) => /cache-[0-4]\.data$/.test(path))).toBe(true)
    expect(result.some((path) => /cache-[5-9]\.data$/.test(path))).toBe(true)
  })
})
