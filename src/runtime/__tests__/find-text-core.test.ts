import { describe, expect, test } from 'bun:test'

import { type Fiber, type Rect, findTextInTree } from '../find-text-core'

const WINDOW = { width: 400, height: 800 }

/** A host component whose instance is DOM-like (react-dom, react-native-web). */
function host(props: Record<string, unknown>, rect?: Rect, displayed = true): Fiber {
  return {
    tag: 5,
    memoizedProps: props,
    stateNode: rect ? { getBoundingClientRect: () => rect, checkVisibility: () => displayed } : null,
    child: null,
    sibling: null,
    return: null,
  }
}

function text(content: string): Fiber {
  return { tag: 6, memoizedProps: content, stateNode: null, child: null, sibling: null, return: null }
}

/** Links parent -> children (as a sibling chain) and each child -> parent. */
function tree(parent: Fiber, ...children: Fiber[]): Fiber {
  parent.child = children[0] ?? null
  children.forEach((c, i) => {
    c.return = parent
    c.sibling = children[i + 1] ?? null
  })
  return parent
}

const onScreenRect = { x: 20, y: 200, width: 60, height: 16 }

describe('findTextInTree', () => {
  test('finds visible text and reports it on screen', () => {
    const root = tree(host({}), tree(host({}, onScreenRect), text('Agent Ride')))
    expect(findTextInTree([root], 'Agent Ride', WINDOW)).toMatchObject({ found: 1, onScreen: 1 })
  })

  test('ignores text under an inactive react-native-screens screen', () => {
    const inactive = tree(host({ activityState: 0 }), tree(host({}, onScreenRect), text('Agent Ride')))
    const active = tree(host({ activityState: 2 }), tree(host({}, onScreenRect), text('Account')))
    const result = findTextInTree([tree(host({}), inactive, active)], 'Agent Ride', WINDOW)
    expect(result).toMatchObject({ found: 1, onScreen: 0 })
  })

  test('treats display:none and off-window rects as not on screen', () => {
    const hidden = tree(host({}, onScreenRect, false), text('Hidden'))
    const below = tree(host({}, { x: 0, y: 900, width: 50, height: 10 }), text('Below'))
    expect(findTextInTree([hidden], 'Hidden', WINDOW).onScreen).toBe(0)
    expect(findTextInTree([below], 'Below', WINDOW).onScreen).toBe(0)
  })

  test('measures native hosts through Fabric, which reports hidden ones as empty', () => {
    const shown = { shadow: 'shown' }
    const hidden = { shadow: 'hidden' }
    const g = globalThis as { nativeFabricUIManager?: unknown }
    g.nativeFabricUIManager = {
      measureInWindow: (node: unknown, done: (...xywh: number[]) => void) =>
        node === shown ? done(20, 200, 60, 16) : done(0, 0, 0, 0),
    }
    try {
      const fabric = (node: unknown, content: string) =>
        tree({ ...host({}), stateNode: { node, canonical: {} } }, text(content))
      const root = tree(host({}), fabric(shown, 'Seeded'), fabric(hidden, 'Hidden'))
      expect(findTextInTree([root], 'Seeded', WINDOW).matches).toEqual([
        { text: 'Seeded', rect: onScreenRect, onScreen: true },
      ])
      expect(findTextInTree([root], 'Hidden', WINDOW)).toMatchObject({ found: 1, onScreen: 0 })
    } finally {
      delete g.nativeFabricUIManager
    }
  })

  test("finds react-dom's lone string children once, and React Native's Text once", () => {
    const dom = host({ children: 'Seeded' }, onScreenRect)
    expect(findTextInTree([dom], 'Seeded', WINDOW)).toMatchObject({ found: 1, onScreen: 1 })

    const nativeText = tree(host({ children: 'Seeded' }, onScreenRect), text('Seeded'))
    expect(findTextInTree([nativeText], 'Seeded', WINDOW).found).toBe(1)
  })

  test('matches substrings by default and whole strings with exact', () => {
    const root = tree(host({}, onScreenRect), text('Agent Ride'))
    expect(findTextInTree([root], 'Ride', WINDOW).found).toBe(1)
    expect(findTextInTree([root], 'Ride', WINDOW, { exact: true }).found).toBe(0)
  })
})
