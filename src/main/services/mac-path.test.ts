import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const paths = vi.hoisted(() => ({ home: '', data: '' }))
vi.mock('electron', () => ({ app: { getPath: () => paths.data } }))
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => paths.home
}))
import { correctMacPath, inspectMacPath, inspectPathText, restoreMacPath } from './mac-path'

describe('literal shell PATH analysis', () => {
  it('does not rewrite data that looks like PATH inside a multiline string or heredoc', async () => {
    expect((await inspectPathText('cat <<EOF\nexport PATH="/usr/bin"\nEOF', '/tmp')).lines).toEqual(
      []
    )
    expect(
      (await inspectPathText('MESSAGE="hello\nexport PATH=\'/usr/bin\'\nworld"', '/tmp')).lines
    ).toEqual([])
  })

  it('keeps dynamic shell code and unsupported expansions out of editable plans', async () => {
    const source = [
      "# Don't change comments",
      '# export PATH="/comment"',
      'export PATH="$(danger):$PATH"',
      'export PATH="$HOME_OTHER/bin:$PATH"',
      'export PATH="/usr/bin:/usr/bin:$PATH"',
      "export PATH='$HOME/bin'",
      'echo do-something'
    ].join('\n')
    const plan = await inspectPathText(source, '/Users/example')
    expect(plan.skipped).toBe(3)
    expect(plan.lines).toHaveLength(1)
    expect(plan.lines[0].parts.map((part) => part.status)).toEqual(['ok', 'duplicate', 'dynamic'])
  })
})

describe.skipIf(process.platform !== 'darwin')('shell correction and restoration', () => {
  let fixture: string
  beforeEach(async () => {
    fixture = await realpath(await mkdtemp(join(tmpdir(), 'kudu-path-test-')))
    paths.home = join(fixture, 'home')
    paths.data = join(fixture, 'data')
    await mkdir(paths.home)
  })
  afterEach(() => rm(fixture, { recursive: true, force: true }))

  it('preserves unrelated configuration, quoting and CRLF while removing duplicates and missing entries', async () => {
    const original =
      'export OTHER="keep"\r\nexport PATH="/usr/bin:/usr/bin:/no-such-kudu-path:$PATH"\r\n# tail\r\n'
    const path = join(paths.home, '.zshrc')
    await writeFile(path, original)
    let plan = await inspectMacPath('.zshrc')
    expect(plan.lines[0].parts[2].status).toBe('missing')
    plan = await correctMacPath({ file: '.zshrc', hash: plan.hash, orders: [[0, 3]] })
    expect(await readFile(path, 'utf8')).toBe(
      'export OTHER="keep"\r\nexport PATH="/usr/bin:$PATH"\r\n# tail\r\n'
    )
    expect(plan.canRestore).toBe(true)
    await restoreMacPath('.zshrc')
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('refuses stale plans, removal of inherited PATH and restoration over later edits', async () => {
    const path = join(paths.home, '.zshrc')
    await writeFile(path, 'export PATH="/usr/bin:$PATH"\n')
    let plan = await inspectMacPath('.zshrc')
    await expect(
      correctMacPath({ file: '.zshrc', hash: plan.hash, orders: [[0]] })
    ).rejects.toThrow('inherited')
    await writeFile(path, 'export PATH="/bin:$PATH"\n')
    await expect(
      correctMacPath({ file: '.zshrc', hash: plan.hash, orders: [[1, 0]] })
    ).rejects.toThrow('changed')
    plan = await inspectMacPath('.zshrc')
    await correctMacPath({ file: '.zshrc', hash: plan.hash, orders: [[1, 0]] })
    await writeFile(path, 'export PATH="/bin:$PATH"\n# edited elsewhere')
    await expect(restoreMacPath('.zshrc')).rejects.toThrow('edited')
  })

  it('refuses symlinked configs and arbitrary file names', async () => {
    const managed = join(fixture, 'managed')
    await writeFile(managed, 'export PATH="/usr/bin:$PATH"')
    await symlink(managed, join(paths.home, '.zshrc'))
    await expect(inspectMacPath('.zshrc')).rejects.toThrow('regular file')
    await expect(inspectMacPath('../managed')).rejects.toThrow('Unsupported')
  })
})
