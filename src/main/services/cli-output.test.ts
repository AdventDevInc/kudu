import { describe, expect, it } from 'vitest'
import { Writable } from 'stream'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { flushCliOutput } from './cli-output'

describe('CLI output flushing', () => {
  it('waits for queued writes on both streams', async () => {
    const received: string[] = []
    const stream = () => new Writable({ write(chunk, _encoding, callback) {
      setTimeout(() => { received.push(chunk.toString()); callback() }, 5)
    } })
    const stdout = stream()
    const stderr = stream()
    stdout.write('result')
    stderr.write('diagnostic')
    await flushCliOutput([stdout, stderr])
    expect(received).toContain('result')
    expect(received).toContain('diagnostic')
    expect(stdout.writableEnded).toBe(false)
    stdout.destroy(); stderr.destroy()
  })

  it('delivers large JSON through a real pipe before immediate exit', async () => {
    // Use the actual compiled helper in a fresh Node process. Its output is
    // intentionally much larger than an OS pipe buffer, like a large scan.
    const script = `const flush = ${flushCliOutput.toString()};
      process.stdout.write(JSON.stringify({ scan: { data: 'x'.repeat(2 * 1024 * 1024) } }));
      flush().then(() => process.exit(0));`
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', script], { maxBuffer: 4 * 1024 * 1024 })
    expect(JSON.parse(stdout).scan.data).toHaveLength(2 * 1024 * 1024)
  })
})
