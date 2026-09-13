import { mkdir, readFile, writeFile, rename, lstat, unlink } from 'fs/promises'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import { validCustomRule } from '../../shared/custom-cleaners'
import type { CustomCleanerRule } from '../../shared/custom-cleaners'

export class CustomCleanerStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private file: string) {}
  async list(): Promise<CustomCleanerRule[]> {
    let info
    try {
      info = await lstat(this.file)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 131072)
      throw new Error('Invalid custom-cleaner file')
    const value = JSON.parse(await readFile(this.file, 'utf8')) as {
      version?: unknown
      rules?: unknown
    }
    if (
      value.version !== 1 ||
      !Array.isArray(value.rules) ||
      value.rules.length > 20 ||
      !value.rules.every(validCustomRule) ||
      new Set(value.rules.map((r) => r.id)).size !== value.rules.length
    )
      throw new Error(
        'Custom-cleaner definitions are corrupt or unsupported. Existing definitions were preserved.'
      )
    return value.rules
  }
  update(transform: (rules: CustomCleanerRule[]) => CustomCleanerRule[]): Promise<void> {
    const work = async () => {
      const rules = transform(await this.list())
      if (
        rules.length > 20 ||
        !rules.every(validCustomRule) ||
        new Set(rules.map((r) => r.id)).size !== rules.length
      )
        throw new Error('Invalid definitions or the 20-rule limit was exceeded')
      const json = JSON.stringify({ version: 1, rules }, null, 2)
      if (Buffer.byteLength(json) > 131072)
        throw new Error('Custom-cleaner definitions exceed the storage limit')
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, json, { flag: 'wx', mode: 0o600 })
        await rename(temp, this.file)
      } finally {
        await unlink(temp).catch(() => {})
      }
    }
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => {})
    return next
  }
}
