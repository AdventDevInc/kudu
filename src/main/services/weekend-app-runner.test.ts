import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'vm'
import { weekendKey } from '../../shared/app-launch'
import { WEEKEND_APP_RUNNER } from './weekend-app-runner'

describe('weekend application opening', () => {
  it('uses the same local Saturday for Sunday, including across the year boundary', () => {
    expect(weekendKey(new Date(2022, 11, 31, 12))).toBe('2022-12-31')
    expect(weekendKey(new Date(2023, 0, 1, 12))).toBe('2022-12-31')
    expect(weekendKey(new Date(2023, 0, 2, 12))).toBeNull()
  })

  it('checks days in local time rather than using UTC date strings', () => {
    for (let day = 5; day <= 11; day++) {
      const date = new Date(2026, 0, day, 0, 1)
      expect(weekendKey(date) !== null).toBe([0, 6].includes(date.getDay()))
    }
  })

  it('runs the standalone program only once per weekend and retries an opening failure', () => {
    const files = new Map<string, string>([
      [
        '/schedule/config.json',
        JSON.stringify({
          appPath: '/Applications/An app "quoted".app'
        })
      ]
    ])
    let now = new Date(2026, 0, 2, 12)
    let openings = 0
    let status = 0
    const task = {
      arguments: [] as string[],
      get launch() {
        openings++
        return undefined
      },
      get waitUntilExit() {
        return undefined
      },
      get terminationStatus() {
        return status
      }
    }
    const foundation = Object.assign(
      (text: string) => ({
        writeToFileAtomicallyEncodingError(path: string) {
          files.set(path, text)
          return true
        }
      }),
      {
        NSUTF8StringEncoding: 4,
        NSString: { stringWithContentsOfFileEncodingError: (path: string) => files.get(path) },
        NSFileManager: { defaultManager: { fileExistsAtPath: (path: string) => files.has(path) } },
        NSFileHandle: { fileHandleWithNullDevice: {} },
        NSTask: { alloc: { init: task } }
      }
    )
    class Clock extends Date {
      constructor(value?: Date | string) {
        super(value === undefined ? now.getTime() : new Date(value).getTime())
      }
    }
    const context = {
      $: foundation,
      ObjC: { import() {}, unwrap: (value: unknown) => value },
      Date: Clock
    }
    runInNewContext(WEEKEND_APP_RUNNER, context)
    const run = () => runInNewContext('run(["/schedule"])', context)
    run() // Friday
    expect(openings).toBe(0)
    now = new Date(2026, 0, 3, 12)
    status = 1
    expect(run).toThrow()
    expect(openings).toBe(1)
    status = 0
    run() // Saturday, retry succeeds
    expect(openings).toBe(2)
    expect(task.arguments).toEqual(['-a', '/Applications/An app "quoted".app'])
    run() // another login
    now = new Date(2026, 0, 4, 23)
    run() // Sunday
    expect(openings).toBe(2)
    now = new Date(2026, 0, 5, 8)
    run() // missed calendar jobs after waking Monday must not open anything
    expect(openings).toBe(2)
    now = new Date(2026, 0, 10, 12)
    run()
    expect(openings).toBe(3)
    files.set(
      '/schedule/config.json',
      JSON.stringify({
        appPath: '/Applications/An app "quoted".app',
        policy: { days: [1, 3], frequency: 'daily' }
      })
    )
    now = new Date(2026, 0, 12, 12)
    run()
    run()
    expect(openings).toBe(4)
    now = new Date(2026, 0, 14, 12)
    run()
    expect(openings).toBe(5)
    now = new Date(2026, 0, 15, 12)
    run()
    expect(openings).toBe(5)
  })
})
