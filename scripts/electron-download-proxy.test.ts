import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('Electron Builder proxy dependency override', () => {
  it('downloads an artifact through the configured proxy', () => {
    // Bootstrap replaces Node's global agents. Exercise the actual downloader
    // in a child so those changes cannot affect other tests or network traffic.
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        `
        const assert = require('node:assert/strict')
        const http = require('node:http')
        const { mkdtemp, readFile, rm } = require('node:fs/promises')
        const { createRequire } = require('node:module')
        const { tmpdir } = require('node:os')
        const { join } = require('node:path')

        async function run() {
          const requests = []
          const proxy = http.createServer((req, res) => {
            requests.push(req.url)
            res.end('electron-download-fixture')
          })
          const cacheRoot = await mkdtemp(join(tmpdir(), 'kudu-proxy-test-'))
          try {
            await new Promise((resolve, reject) => {
              proxy.once('error', reject)
              proxy.listen(0, '127.0.0.1', resolve)
            })
            process.env.ELECTRON_GET_USE_PROXY = 'true'
            process.env.GLOBAL_AGENT_HTTP_PROXY = 'http://127.0.0.1:' + proxy.address().port
            process.env.GLOBAL_AGENT_HTTPS_PROXY = process.env.GLOBAL_AGENT_HTTP_PROXY
            process.env.GLOBAL_AGENT_NO_PROXY = ''
            process.env.GLOBAL_AGENT_ENVIRONMENT_VARIABLE_NAMESPACE = 'GLOBAL_AGENT_'
            const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
            const { downloadArtifact } = builderRequire('@electron/get')
            const artifact = await downloadArtifact({
              version: '0.0.0',
              artifactName: 'electron',
              platform: 'win32',
              arch: 'x64',
              cacheRoot,
              // The local proxy serves fixture bytes, not a release archive.
              unsafelyDisableChecksums: true,
              mirrorOptions: { mirror: 'http://kudu.invalid/' }
            })
            assert.equal(await readFile(artifact, 'utf8'), 'electron-download-fixture')
            assert.deepEqual(requests, ['http://kudu.invalid/v0.0.0/electron-v0.0.0-win32-x64.zip'])
            console.log('proxy download passed')
          } finally {
            proxy.closeAllConnections()
            await new Promise(resolve => proxy.close(resolve))
            await rm(cacheRoot, { recursive: true, force: true })
          }
        }
        run().catch(error => { console.error(error); process.exitCode = 1 })
        `
      ],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true }
    )
    expect(output).toContain('proxy download passed')
  })
})
