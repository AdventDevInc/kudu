import type { Writable } from 'stream'

/** Wait for queued writes before Electron's immediate app.exit terminates us.
 * Pipes are asynchronous on Unix, so a successful write() does not mean that
 * the consumer has received the entire JSON document yet.
 */
export async function flushCliOutput(streams: Writable[] = [process.stdout, process.stderr]): Promise<void> {
  await Promise.all(streams.map(stream => new Promise<void>((resolve) => {
    if (stream.destroyed || stream.writableEnded) { resolve(); return }
    // An empty write is queued behind all earlier output. Do not end stdout:
    // Electron may still emit shutdown diagnostics.
    stream.write('', () => resolve())
  })))
}
