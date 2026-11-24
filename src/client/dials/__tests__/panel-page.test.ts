import { describe, expect, test } from 'bun:test'

import { PANEL_HTML } from '../panel-page'

const ROUTES = ['/api/dials', '/api/dials/set', '/api/events']

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
  })

  test('mentions every route and the auth header it uses', () => {
    for (const route of ROUTES) expect(PANEL_HTML).toContain(route)
    expect(PANEL_HTML).toContain('x-dials-key')
    expect(PANEL_HTML).toContain('EventSource')
  })
})
