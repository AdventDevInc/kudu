import { app } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { homedir } from 'os'
import type { MacPathPlan, PathLine } from '../../shared/mac-tools'

export const SHELL_FILES = ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile']
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const store = () => join(app.getPath('userData'), 'mac-tools', 'path')
let editing: Promise<unknown> = Promise.resolve()

function filePath(file: unknown): string {
  if (process.platform !== 'darwin' || typeof file !== 'string' || !SHELL_FILES.includes(file)) {
    throw new Error('Unsupported shell file.')
  }
  return join(homedir(), file)
}

async function readConfig(file: unknown) {
  const path = filePath(file)
  const info = await lstat(path)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.size > 1024 * 1024
  ) {
    throw new Error('The configuration must be a regular file owned by your account (up to 1 MB).')
  }
  return { path, info, content: await readFile(path, 'utf8') }
}

/** Parse only standalone literal assignments, preserving quoting and surrounding text. */
export async function inspectPathText(
  content: string,
  home: string
): Promise<{ lines: PathLine[]; skipped: number }> {
  const lines: PathLine[] = []
  let skipped = 0
  // A PATH-looking line inside a heredoc or a multiline string is data, not an assignment.
  let quote = ''
  let escaped = false
  let comment = false
  let multiline = false
  for (let index = 0; index < content.length; index++) {
    const char = content[index]
    if (char === '\n') {
      comment = false
      if (quote) multiline = true
    }
    if (comment) continue
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (!quote && char === '#' && (index === 0 || /\s/.test(content[index - 1]))) {
      comment = true
      continue
    }
    if (!quote && char === '<' && content[index + 1] === '<') multiline = true
    if (char === quote) quote = ''
    else if (!quote && (char === "'" || char === '"')) quote = char
  }
  if (multiline) {
    return {
      lines,
      skipped: content.split('\n').filter((line) => /^\s*(?:export\s+)?PATH=/.test(line)).length
    }
  }
  for (const [number, raw] of content.split('\n').entries()) {
    if (!/^\s*(?:export\s+)?PATH=/.test(raw)) continue
    const match = raw.match(
      /^(\s*(?:export\s+)?PATH=)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#;]+))(\s*)$/
    )
    if (!match) {
      skipped++
      continue
    }
    const quote = match[2] !== undefined ? '"' : match[3] !== undefined ? "'" : ''
    const value = match[2] ?? match[3] ?? match[4]
    // Command substitutions, escapes, expansions and operators need shell evaluation.
    const scrubbed = value.replace(/\$(?:\{(?:HOME|PATH)\}|(?:HOME|PATH)(?![A-Za-z0-9_]))/g, '')
    if (/[$\x60\\;|&<>*?(){}!]/.test(scrubbed) || (quote === "'" && value.includes('$'))) {
      skipped++
      continue
    }
    const seen = new Set<string>()
    const parts: PathLine['parts'] = []
    for (const item of value.split(':')) {
      let status: PathLine['parts'][number]['status'] = 'ok'
      const expanded = item.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home)
      if (['$PATH', '${PATH}'].includes(item)) status = 'dynamic'
      else if (!expanded.startsWith('/')) {
        status = 'unknown'
      } else {
        try {
          if (!(await stat(expanded)).isDirectory()) status = 'missing'
        } catch (error) {
          status = ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
            ? 'missing'
            : 'unknown'
        }
      }
      if (seen.has(expanded) && status !== 'unknown') status = 'duplicate'
      seen.add(expanded)
      parts.push({ value: item, status })
    }
    lines.push({
      number: number + 1,
      original: raw,
      prefix: match[1],
      quote,
      suffix: match[5],
      parts
    })
  }
  return { lines, skipped }
}

async function backup(file: string): Promise<{ before: string; after: string } | null> {
  try {
    const value = JSON.parse(await readFile(join(store(), file + '.json'), 'utf8'))
    if (typeof value.before !== 'string' || typeof value.after !== 'string')
      throw new Error('Invalid PATH backup.')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function inspectMacPath(file: unknown): Promise<MacPathPlan> {
  const { content } = await readConfig(file)
  return {
    file: file as string,
    hash: digest(content),
    ...(await inspectPathText(content, homedir())),
    canRestore: !!(await backup(file as string))
  }
}

async function atomicWrite(path: string, value: string, mode: number) {
  const temp = join(dirname(path), '.kudu-path-' + randomUUID())
  try {
    await writeFile(temp, value, { mode: mode & 0o777, flag: 'wx' })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}

export function correctMacPath(input: unknown): Promise<MacPathPlan> {
  const work = editing.then(async () => {
    const request = input as { file: unknown; hash: unknown; orders: unknown }
    const { path, info, content } = await readConfig(request?.file)
    if (request.hash !== digest(content)) throw new Error('The file changed. Analyze it again.')
    const plan = await inspectPathText(content, homedir())
    if (!Array.isArray(request.orders) || request.orders.length !== plan.lines.length)
      throw new Error('Invalid PATH selection.')
    const output = content.split('\n')
    for (const [index, line] of plan.lines.entries()) {
      const order: unknown = request.orders[index]
      if (
        !Array.isArray(order) ||
        order.length === 0 ||
        new Set(order).size !== order.length ||
        order.some((item) => !Number.isInteger(item) || item < 0 || item >= line.parts.length)
      ) {
        throw new Error('Select at least one existing entry per line.')
      }
      const inherited = (value: string) => ['$PATH', '${PATH}'].includes(value)
      if (
        line.parts.some((part) => inherited(part.value)) &&
        !order.some((index) => inherited(line.parts[index].value))
      ) {
        throw new Error('Keep the inherited PATH entry to preserve commands from your environment.')
      }
      output[line.number - 1] =
        line.prefix +
        line.quote +
        order.map((item) => line.parts[item].value).join(':') +
        line.quote +
        line.suffix
    }
    const after = output.join('\n')
    if (after === content) return inspectMacPath(request.file)
    await mkdir(store(), { recursive: true, mode: 0o700 })
    const file = request.file as string
    // Backup is persisted before modifying the shell configuration.
    await atomicWrite(
      join(store(), file + '.json'),
      JSON.stringify({ before: content, after }),
      0o600
    )
    const current = await readConfig(file)
    if (digest(current.content) !== request.hash || current.info.ino !== info.ino)
      throw new Error('The file changed. Analyze it again.')
    await atomicWrite(path, after, info.mode)
    return inspectMacPath(file)
  })
  editing = work.catch(() => {})
  return work
}

export function restoreMacPath(file: unknown): Promise<MacPathPlan> {
  const work = editing.then(async () => {
    const current = await readConfig(file)
    const snapshot = await backup(file as string)
    if (!snapshot) throw new Error('No PATH backup available.')
    if (current.content !== snapshot.after && current.content !== snapshot.before) {
      throw new Error(
        'The file was edited after the correction. Restore the backup manually to preserve those edits.'
      )
    }
    await atomicWrite(current.path, snapshot.before, current.info.mode)
    await rm(join(store(), file + '.json'))
    return inspectMacPath(file)
  })
  editing = work.catch(() => {})
  return work
}
