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

describe('device label', () => {
  const src = /function devLabel\(name\) \{[\s\S]*?\n  \}/.exec(PANEL_HTML)?.[0]
  const devLabel = new Function(`${src}; return devLabel`)() as (name: string) => string

  test('uses the simulator name', () => {
    expect(devLabel('sprout (host.exp.Exponent (iPhone 18 Pro) [Rider])')).toBe('Rider')
  })

  test('falls back to the model when the simulator name is machine-made', () => {
    expect(
      devLabel('sprout (host.exp.Exponent (iPhone 18 Pro) [simlock-2363a936-c853-471e-bd93-cffbd6800e46])'),
    ).toBe('iPhone 18 Pro')
  })

  test('keeps a plain name', () => {
    expect(devLabel('sprout')).toBe('sprout')
  })

  test('holds the capture while a dial is mid-drag, so the outline does not blink', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(PANEL_HTML)![1]!
    const timer = /capTimers\[id\] = setTimeout\(function \(\) \{([\s\S]*?)\}, 400\)/.exec(script)![1]!
    expect(timer).toMatch(/if \(dragAt\[id\][^\n]*\) return\n\s*doCapture\(id\)/)
    expect(script).toMatch(/function throttled\(id, v\) \{\s*dragAt\[id\] = Date\.now\(\)/)
    expect(script).toMatch(/function release\(id, v\) \{\s*delete dragAt\[id\]/)
  })
})

type Dial = {
  id: string
  label?: string
  group?: string
  desc?: string
  screens?: string[]
  onScreen?: boolean
  source?: { file: string; line?: number }
}

const panelScript = /<script>([\s\S]*)<\/script>/.exec(PANEL_HTML)![1]!

function fn(name: string): string {
  return new RegExp(`  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`).exec(panelScript)![0]
}

// Runs the real helpers against a fake S and dial list.
function harness(dials: Dial[], S: { by?: string | null; here?: boolean; filter?: string }) {
  const src = [
    'var S = ctx.S; function dials() { return ctx.dials }',
    fn('humanize'),
    fn('lab'),
    fn('split'),
    fn('hasScreens'),
    fn('curBy'),
    fn('fileOf'),
    fn('place'),
    fn('srcLine'),
    fn('tree'),
    'return { tree: tree, srcLine: srcLine, curBy: curBy, hasScreens: hasScreens }',
  ].join('\n')
  return new Function('ctx', src)({ S: { by: null, here: false, filter: '', ...S }, dials }) as {
    tree: () => { name: string; els: { name: string; dials: Dial[] }[] }[]
    srcLine: (d: Dial) => string
    curBy: () => string
    hasScreens: () => boolean
  }
}

const sample: Dial[] = [
  {
    id: 'card.gap',
    label: 'Gap',
    group: 'Plant card / Name',
    desc: 'Space between cards',
    screens: ['shop', 'home'],
    onScreen: true,
    source: { file: 'src/app/index.tsx', line: 44 },
  },
  { id: 'hero.pad', group: 'Hero', screens: ['home'], onScreen: false, source: { file: 'src/app/home.tsx' } },
  { id: 'misc.x', source: { file: 'src/ui/misc.tsx' } },
]

describe('dials panel descriptions and screens', () => {
  test('script still parses', () => {
    expect(() => new Function(panelScript)).not.toThrow()
  })

  test('has the exact new labels', () => {
    for (const t of ['Group by', 'Screen', 'Group', 'File', 'This screen', 'Not on screen']) {
      expect(PANEL_HTML).toContain(t)
    }
  })

  test('renders desc in the list card, single view and commit list', () => {
    expect(panelScript).toMatch(/d\.desc \? h\("span", \{ class: "desc", text: d\.desc \}\)/g)
    expect(panelScript.match(/class: "desc"/g)!.length).toBe(3)
  })

  test('filter matches desc', () => {
    const t = harness(sample, { by: 'group', filter: 'space between' }).tree()
    expect(t.flatMap(s => s.els.flatMap(e => e.dials.map(d => d.id)))).toEqual(['card.gap'])
  })

  test('defaults to Screen when a dial has screens, else Group', () => {
    expect(harness(sample, {}).curBy()).toBe('screen')
    expect(harness([{ id: 'a' }], {}).curBy()).toBe('group')
    expect(harness(sample, { by: 'file' }).curBy()).toBe('file')
  })

  test('groups by screen: first screen, rest under Not on screen', () => {
    const t = harness(sample, { by: 'screen' }).tree()
    expect(t.map(s => s.name)).toEqual(['shop', 'home', 'Not on screen'])
    expect(t[0]!.els.map(e => e.name)).toEqual(['Name'])
    expect(t[2]!.els.map(e => e.name)).toEqual(['General'])
  })

  test('groups by group as before', () => {
    const t = harness(sample, { by: 'group' }).tree()
    expect(t.map(s => s.name)).toEqual(['Plant card', 'Hero', 'General'])
  })

  test('groups by file name', () => {
    const t = harness(sample, { by: 'file' }).tree()
    expect(t.map(s => s.name)).toEqual(['index.tsx', 'home.tsx', 'misc.tsx'])
  })

  test('This screen hides off-screen dials', () => {
    const t = harness(sample, { by: 'group', here: true }).tree()
    expect(t.flatMap(s => s.els.flatMap(e => e.dials.map(d => d.id)))).toEqual(['card.gap'])
  })

  test('toggle is hidden without screens and both choices persist in try/catch', () => {
    expect(panelScript).toContain('hidden: !hasScreens()')
    expect(panelScript).toMatch(/try \{ localStorage\.setItem\("dials\.by"/)
    expect(panelScript).toMatch(/try \{ localStorage\.setItem\("dials\.here"/)
    expect(panelScript).toMatch(/try \{ var sb = localStorage\.getItem\("dials\.by"\)/)
  })

  test('src line lists the screens', () => {
    const h = harness(sample, {})
    expect(h.srcLine(sample[0]!)).toBe('shop, home · card.gap · src/app/index.tsx:44')
    expect(h.srcLine(sample[2]!)).toBe('misc.x · src/ui/misc.tsx')
  })
})
