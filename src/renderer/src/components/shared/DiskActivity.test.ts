import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DiskActivity } from './DiskActivity'

describe('disk activity feedback', () => {
  it.each([undefined, -1, NaN, Infinity, 101])('does not invent progress for %s', (percent) => {
    const html = renderToStaticMarkup(
      createElement(DiskActivity, { label: 'Looking for drives', percent })
    )
    expect(html).toContain('role="status"')
    expect(html).toContain('Looking for drives')
    expect(html).toContain('motion-reduce:animate-none')
    expect(html).not.toContain('role="progressbar"')
    expect(html).not.toContain('aria-valuenow')
    expect(html).not.toContain('%')
  })

  it.each([0, 42, 100])('exposes reported progress %s accessibly', (percent) => {
    const html = renderToStaticMarkup(
      createElement(DiskActivity, { label: 'Repairing', percent, message: 'Tool output' })
    )
    expect(html).toContain('role="progressbar"')
    expect(html).toContain(`aria-valuenow="${percent}"`)
    expect(html).toContain(`aria-label="Repairing"`)
    expect(html).toContain(`${percent}%`)
    expect(html).toContain('Tool output')
    expect(html).toContain('motion-reduce:transition-none')
  })
})
