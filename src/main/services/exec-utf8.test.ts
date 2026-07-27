import { describe, it, expect } from 'vitest'
import { spawnTrackedLines } from './exec-utf8'

// Drive a real child process — the point of spawnTrackedLines is its handling
// of stdout chunking, exit codes, timeouts and aborts, none of which a mocked
// ChildProcess would exercise faithfully.
const NODE = process.execPath

function nodeEval(source: string): string[] {
  return ['-e', source]
}

describe('spawnTrackedLines', () => {
  it('delivers one callback per stdout line, without trailing newlines', async () => {
    const lines: string[] = []
    const { code, timedOut } = await spawnTrackedLines(
      NODE,
      nodeEval('process.stdout.write("a\\nb\\nc\\n")'),
      (l) => lines.push(l),
      { timeout: 30_000 }
    )
    expect(lines).toEqual(['a', 'b', 'c'])
    expect(code).toBe(0)
    expect(timedOut).toBe(false)
  })

  it('reassembles lines split across chunk boundaries', async () => {
    const lines: string[] = []
    await spawnTrackedLines(
      NODE,
      nodeEval(
        'process.stdout.write("RUL"); setTimeout(() => process.stdout.write("E|one\\nRULE|tw"), 20); setTimeout(() => process.stdout.write("o\\n"), 40)'
      ),
      (l) => lines.push(l),
      { timeout: 30_000 }
    )
    expect(lines).toEqual(['RULE|one', 'RULE|two'])
  })

  it('emits a final unterminated line when the process exits', async () => {
    const lines: string[] = []
    await spawnTrackedLines(NODE, nodeEval('process.stdout.write("no-newline")'), (l) => lines.push(l), {
      timeout: 30_000,
    })
    expect(lines).toEqual(['no-newline'])
  })

  it('resolves with the exit code instead of throwing, so partial output stays usable', async () => {
    const lines: string[] = []
    const { code, stderr } = await spawnTrackedLines(
      NODE,
      nodeEval('process.stdout.write("kept\\n"); process.stderr.write("boom\\n"); process.exit(3)'),
      (l) => lines.push(l),
      { timeout: 30_000 }
    )
    expect(lines).toEqual(['kept'])
    expect(code).toBe(3)
    expect(stderr).toContain('boom')
  })

  it('reports a timeout via the flag and keeps lines emitted before the kill', async () => {
    const lines: string[] = []
    const { timedOut } = await spawnTrackedLines(
      NODE,
      nodeEval('process.stdout.write("early\\n"); setTimeout(() => {}, 60_000)'),
      (l) => lines.push(l),
      { timeout: 400 }
    )
    expect(lines).toEqual(['early'])
    expect(timedOut).toBe(true)
  })

  it('rejects when the signal aborts mid-run', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    await expect(
      spawnTrackedLines(NODE, nodeEval('setTimeout(() => {}, 60_000)'), () => {}, {
        timeout: 30_000,
        signal: controller.signal,
      })
    ).rejects.toThrow('Operation cancelled')
  })

  it('rejects immediately when the signal is already aborted', async () => {
    await expect(
      spawnTrackedLines(NODE, nodeEval('process.stdout.write("x")'), () => {}, {
        signal: AbortSignal.abort(),
      })
    ).rejects.toThrow('Operation cancelled')
  })

  it('rejects when the executable does not exist', async () => {
    await expect(
      spawnTrackedLines('kudu-no-such-binary-xyz', [], () => {}, { timeout: 5_000 })
    ).rejects.toThrow()
  })
})
