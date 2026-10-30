import { EventEmitter } from 'events'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getVersion: () => '3.10.0',
    getPath: () => '/test/profile',
    quit: vi.fn()
  },
  showMessageBox: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn()
}))
vi.mock('electron', () => ({ app: mocks.app, dialog: { showMessageBox: mocks.showMessageBox } }))
vi.mock('./logger', () => ({ logError: mocks.logError, logInfo: mocks.logInfo }))
vi.mock('../i18n', () => ({ t: (key: string) => key }))

import { attachRendererDiagnostics } from './renderer-diagnostics'

function windowFixture() {
  const wc = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    isDevToolsOpened: () => false,
    openDevTools: vi.fn()
  })
  const win = Object.assign(new EventEmitter(), {
    webContents: wc,
    isDestroyed: vi.fn(() => false)
  })
  attachRendererDiagnostics(win as unknown as BrowserWindow, {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false
  })
  return { wc, win }
}

describe('renderer startup diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.app.isPackaged = true
    mocks.showMessageBox.mockImplementation(() => new Promise(() => {}))
  })

  it('shows one native dialog before first paint with signed NTSTATUS and sandbox context', async () => {
    const { wc } = windowFixture()
    let dismiss!: () => void
    mocks.showMessageBox.mockImplementation(
      () => new Promise<void>((resolve) => (dismiss = resolve))
    )
    for (let i = 0; i < 3; i++) {
      wc.emit('render-process-gone', {}, { reason: 'launch-failed', exitCode: -1073740756 })
    }
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
    const [options] = mocks.showMessageBox.mock.calls[0]
    expect(options).toMatchObject({
      type: 'error',
      title: 'rendererStartupFailureTitle',
      message: 'rendererStartupFailureMessage',
      buttons: ['quit']
    })
    expect(options.detail).toContain('exitCode=-1073740756 (0xC000042C)')
    expect(options.detail).toContain('sandbox=true contextIsolation=true nodeIntegration=false')
    expect(options.detail).toContain(join('/test/profile', 'logs', 'kudu.log'))
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining(options.detail))
    expect(wc.openDevTools).not.toHaveBeenCalled()
    expect(mocks.app.quit).not.toHaveBeenCalled()
    dismiss()
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledTimes(1))
  })

  it('only treats non-aborted startup main-frame load failures as fatal', () => {
    const { wc } = windowFixture()
    wc.emit('did-fail-load', {}, -3, 'ABORTED', 'file:///index.html', true)
    wc.emit('did-fail-load', {}, -6, 'NOT_FOUND', 'file:///frame.html', false)
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
    wc.emit('did-fail-load', {}, -6, 'NOT_FOUND', 'file:///index.html', true)
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
    expect(mocks.showMessageBox.mock.calls[0][0].detail).toContain('code=-6 desc=NOT_FOUND')
  })

  it('keeps runtime crash DevTools behavior after a successful load', () => {
    const { wc } = windowFixture()
    wc.emit('did-finish-load')
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    wc.emit('did-fail-load', {}, -6, 'NOT_FOUND', 'file:///index.html', true)
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
    expect(wc.openDevTools).toHaveBeenCalledWith({ mode: 'detach' })
  })

  it.each(['clean-exit', 'killed'])(
    'does not treat intentional %s as startup failure',
    (reason) => {
      const { wc } = windowFixture()
      wc.emit('render-process-gone', {}, { reason, exitCode: 0 })
      expect(mocks.showMessageBox).not.toHaveBeenCalled()
    }
  )

  it.each(['development', 'destroyed window', 'destroyed contents'])(
    'does not show a dialog for %s',
    (state) => {
      const { wc, win } = windowFixture()
      if (state === 'development') mocks.app.isPackaged = false
      if (state === 'destroyed window') win.isDestroyed.mockReturnValue(true)
      if (state === 'destroyed contents') wc.isDestroyed.mockReturnValue(true)
      wc.emit('render-process-gone', {}, { reason: 'launch-failed', exitCode: 1 })
      expect(mocks.showMessageBox).not.toHaveBeenCalled()
    }
  )

  it('logs a dialog rejection and quits without an unhandled rejection', async () => {
    mocks.showMessageBox.mockRejectedValue(new Error('dialog unavailable'))
    const { wc } = windowFixture()
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledTimes(1))
    expect(mocks.logError).toHaveBeenCalledWith(
      'Could not show renderer startup failure dialog:',
      expect.any(Error)
    )
  })
})
