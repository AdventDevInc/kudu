import { describe, it, expect } from 'vitest'
import { execTracked, spawnTrackedLines, ConsoleOutputDecoder } from './exec-utf8'

// Drive a real child process — the point of spawnTrackedLines is its handling
// of stdout chunking, exit codes, timeouts and aborts, none of which a mocked
// ChildProcess would exercise faithfully.
const NODE = process.execPath

it('executes with the supplied environment instead of inheriting removed overrides', async () => {
  const result = await execTracked(
    NODE,
    ['-e', 'process.stdout.write(process.env.KUDU_COMMAND_TEST || "missing")'],
    {
      env: { ...process.env, KUDU_COMMAND_TEST: 'isolated' }
    }
  )
  expect(result.stdout).toBe('isolated')
})

function nodeEval(source: string): string[] {
  return ['-e', source]
}

describe('spawnTrackedLines', () => {
  it('passes the supplied environment to the helper process', async () => {
    const lines: string[] = []
    const result = await spawnTrackedLines(
      NODE,
      nodeEval('console.log(process.env.KUDU_COMMAND_TEST)'),
      (line) => lines.push(line),
      { env: { ...process.env, KUDU_COMMAND_TEST: 'isolated' } }
    )
    expect(result.code).toBe(0)
    expect(lines).toEqual(['isolated'])
  })

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
    await spawnTrackedLines(
      NODE,
      nodeEval('process.stdout.write("no-newline")'),
      (l) => lines.push(l),
      {
        timeout: 30_000
      }
    )
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
        signal: controller.signal
      })
    ).rejects.toThrow('Operation cancelled')
  })

  it('rejects immediately when the signal is already aborted', async () => {
    await expect(
      spawnTrackedLines(NODE, nodeEval('process.stdout.write("x")'), () => {}, {
        signal: AbortSignal.abort()
      })
    ).rejects.toThrow('Operation cancelled')
  })

  it('rejects when the executable does not exist', async () => {
    await expect(
      spawnTrackedLines('kudu-no-such-binary-xyz', [], () => {}, { timeout: 5_000 })
    ).rejects.toThrow()
  })
})

describe('ConsoleOutputDecoder', () => {
  it('decodes UTF-8 output when no control bytes are present', () => {
    const d = new ConsoleOutputDecoder()
    const text = 'Проверка 42% complete'
    const bytes = Buffer.from(text, 'utf-8')
    // split inside a multi-byte sequence to exercise chunk boundaries
    expect(d.write(bytes.subarray(0, 3)) + d.write(bytes.subarray(3)) + d.end()).toBe(text)
  })

  it('decodes UTF-16LE output as emitted by sfc.exe on a redirected stdout', () => {
    const d = new ConsoleOutputDecoder()
    const text = 'Начато сканирование системы. Windows 42% complete'
    const bytes = Buffer.from(text, 'utf16le')
    // odd split leaves half a code unit pending
    expect(d.write(bytes.subarray(0, 7)) + d.write(bytes.subarray(7)) + d.end()).toBe(text)
  })

  it('strips a UTF-16LE BOM', () => {
    const d = new ConsoleOutputDecoder()
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ok', 'utf16le')])
    expect(d.write(bytes) + d.end()).toBe('ok')
  })
})

describe('ConsoleOutputDecoder (chunk boundaries)', () => {
  it('waits for a second byte before sniffing so a lone leading byte cannot mis-select UTF-8', () => {
    const d = new ConsoleOutputDecoder()
    const bytes = Buffer.from('\r\nVerification 1% complete.', 'utf16le')
    const out = d.write(bytes.subarray(0, 1)) + d.write(bytes.subarray(1)) + d.end()
    expect(out).toBe('\r\nVerification 1% complete.')
  })

  it('flushes a single held byte as UTF-8 on end', () => {
    const d = new ConsoleOutputDecoder()
    expect(d.write(Buffer.from('x')) + d.end()).toBe('x')
  })
})
