import { describe, it, expect } from 'vitest'
import Ajv from 'ajv'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'

const RULES_DIR = path.resolve(__dirname, '..', '..', '..', 'rules')
const SCHEMA_PATH = path.join(RULES_DIR, 'schema', 'rules.schema.json')
const PLATFORMS = ['win32', 'darwin', 'linux'] as const

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'))
const ajv = new Ajv({ allErrors: true })
const validate = ajv.compile(schema)

// Known template variables per platform
const VALID_VARS: Record<string, Set<string>> = {
  win32: new Set(['HOME', 'LOCALAPPDATA', 'APPDATA', 'WINDIR', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES_X86', 'TMPDIR']),
  darwin: new Set(['HOME', 'LIBRARY', 'CACHES', 'APP_SUPPORT', 'TMPDIR']),
  linux: new Set(['HOME', 'CONFIG', 'CACHE', 'LOCAL_SHARE', 'TMPDIR']),
}

function loadJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf-8'))
}

function extractVars(obj: unknown): string[] {
  const vars: string[] = []
  const re = /\$\{([A-Z0-9_]+)\}/g
  JSON.stringify(obj).replace(re, (_match, name) => {
    vars.push(name)
    return ''
  })
  return vars
}

describe('rules schema validation', () => {
  it('rejects combining childSubdir with recursiveMatch', () => {
    expect(validate({
      type: 'apps',
      apps: [{
        id: 'bad-rule',
        name: 'Bad Rule',
        paths: ['${HOME}/cache'],
        childSubdir: 'cache',
        recursiveMatch: { anchor: 'EBWebView', targets: ['Cache'] },
      }],
    })).toBe(false)
  })

  it('rejects path-shaped recursive match names', () => {
    expect(validate({
      type: 'apps',
      apps: [{
        id: 'bad-rule',
        name: 'Bad Rule',
        paths: ['${HOME}/cache'],
        recursiveMatch: { anchor: 'EBWebView', targets: ['Default/Cache'] },
      }],
    })).toBe(false)
  })

  it('rejects combining fileMatch with another path-expansion mode', () => {
    expect(validate({
      type: 'apps',
      apps: [{
        id: 'bad-rule',
        name: 'Bad Rule',
        paths: ['${HOME}/cache'],
        childSubdir: 'cache',
        fileMatch: { names: ['installer.exe'], minAgeDays: 14 },
      }],
    })).toBe(false)
  })

  it('rejects path-shaped direct file match names', () => {
    expect(validate({
      type: 'apps',
      apps: [{
        id: 'bad-rule',
        name: 'Bad Rule',
        paths: ['${HOME}/cache'],
        fileMatch: { names: ['pending/installer.exe'], minAgeDays: 14 },
      }],
    })).toBe(false)
  })

  for (const platform of PLATFORMS) {
    describe(platform, () => {
      const platformDir = path.join(RULES_DIR, platform)
      const files = readdirSync(platformDir).filter((f) => f.endsWith('.json'))

      it(`has all 8 expected rule files`, () => {
        const expected = ['system.json', 'browsers.json', 'apps.json', 'gaming.json', 'gpu-cache.json', 'steam.json', 'databases.json', 'misc.json']
        for (const f of expected) {
          expect(files, `missing ${f} for ${platform}`).toContain(f)
        }
      })

      for (const file of files) {
        const filePath = path.join(platformDir, file)

        it(`${file} is valid JSON`, () => {
          expect(() => loadJson(filePath)).not.toThrow()
        })

        it(`${file} passes schema validation`, () => {
          const data = loadJson(filePath)
          const valid = validate(data)
          if (!valid) {
            const errors = validate.errors?.map((e) => `${e.instancePath} ${e.message}`).join('\n')
            expect.fail(`Schema validation failed for ${platform}/${file}:\n${errors}`)
          }
        })

        it(`${file} only uses valid template variables for ${platform}`, () => {
          const data = loadJson(filePath)
          const vars = extractVars(data)
          const validSet = VALID_VARS[platform]
          for (const v of vars) {
            expect(validSet.has(v), `Unknown variable \${${v}} in ${platform}/${file}`).toBe(true)
          }
        })
      }

      // Check unique IDs in apps/gaming/gpu-cache files
      for (const file of ['apps.json', 'gaming.json', 'gpu-cache.json']) {
        it(`${file} has unique app IDs`, () => {
          const data = loadJson(path.join(platformDir, file)) as { apps: Array<{ id: string }> }
          const ids = data.apps.map((a) => a.id)
          expect(new Set(ids).size, `Duplicate IDs in ${platform}/${file}`).toBe(ids.length)
        })
      }

      // Check unique labels in databases.json
      it('databases.json has unique target labels', () => {
        const data = loadJson(path.join(platformDir, 'databases.json')) as { targets: Array<{ label: string }> }
        const labels = data.targets.map((t) => t.label)
        expect(new Set(labels).size, `Duplicate labels in ${platform}/databases.json`).toBe(labels.length)
      })
    })
  }
})
