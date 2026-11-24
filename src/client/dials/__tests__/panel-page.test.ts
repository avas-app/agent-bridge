import { describe, expect, test } from 'bun:test'

import { PANEL_HTML } from '../panel-page'

const ROUTES = [
  '/api/dials',
  '/api/dials/set',
  '/api/events',
  '/api/highlight',
  '/api/capture',
  '/api/capture-variants',
  '/api/commit',
]

describe('dials panel page', () => {
  test('is a complete HTML document', () => {
    expect(PANEL_HTML.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(PANEL_HTML).toContain('<html')
    expect(PANEL_HTML).toContain('</html>')
    expect(PANEL_HTML).toContain('<script>')
    expect(PANEL_HTML).toContain('<style>')
  })

  test('makes no requests to outside hosts', () => {
    expect(PANEL_HTML).not.toMatch(/https?:\/\//)
    expect(PANEL_HTML).not.toMatch(/\/\/[a-z0-9.-]+\.[a-z]{2,}/i)
    expect(PANEL_HTML).not.toContain('fonts.googleapis')
  })

  test('mentions every route and the auth header it uses', () => {
    for (const route of ROUTES) expect(PANEL_HTML).toContain(route)
    expect(PANEL_HTML).toContain('x-dials-key')
    expect(PANEL_HTML).toContain('EventSource')
  })

  test('uses the Studio fonts and palette, dark by default', () => {
    expect(PANEL_HTML).toContain("'IBM Plex Sans'")
    expect(PANEL_HTML).toContain("'IBM Plex Mono'")
    expect(PANEL_HTML).toContain('#C6F432')
    expect(PANEL_HTML).toContain('#0B0B0C')
  })

  test('script parses and has the three layouts', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(PANEL_HTML)![1]!
    expect(() => new Function(script)).not.toThrow()
    expect(PANEL_HTML).toContain('By element')
    expect(PANEL_HTML).toContain('One dial')
    expect(PANEL_HTML).toContain('max-width:699px')
  })
})
