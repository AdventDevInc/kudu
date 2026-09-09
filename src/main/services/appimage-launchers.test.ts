import { describe, it, expect } from 'vitest'
import { rewriteDesktopExec } from './appimage-launchers'

describe('rewriteDesktopExec', () => {
  const oldPath = '/home/u/.local/bin/Kudu-2.7.0-x86_64.AppImage'
  const newPath = '/home/u/.local/bin/Kudu-x86_64.AppImage'

  it('rewrites Exec lines that reference the old AppImage path', () => {
    const desktop = [
      '[Desktop Entry]',
      'Name=Kudu',
      `Exec=${oldPath}`,
      `TryExec=${oldPath}`,
      'Type=Application',
      '',
    ].join('\n')
    const next = rewriteDesktopExec(desktop, oldPath, newPath)
    expect(next).toContain(`Exec=${newPath}`)
    expect(next).toContain(`TryExec=${newPath}`)
    expect(next).not.toContain(oldPath)
  })

  it('leaves unrelated lines and files alone', () => {
    const desktop = ['[Desktop Entry]', 'Name=Other', 'Exec=/usr/bin/other', ''].join('\n')
    expect(rewriteDesktopExec(desktop, oldPath, newPath)).toBe(desktop)
  })

  it('is a no-op when paths match or are empty', () => {
    const desktop = `Exec=${oldPath}\n`
    expect(rewriteDesktopExec(desktop, oldPath, oldPath)).toBe(desktop)
    expect(rewriteDesktopExec(desktop, '', newPath)).toBe(desktop)
  })
})
