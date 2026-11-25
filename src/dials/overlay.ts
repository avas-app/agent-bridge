import { type ComponentType, createElement, useSyncExternalStore } from 'react'

import { type OutlineView, outlineView, watchHighlight } from './highlight'

const EDGE = 'rgba(11,11,12,0.85)'
const THICK = 2
const ARM = 12
const OFFSET = 4
const RADIUS = 3

type Views = { View?: unknown }
const views = (): Views => {
  try {
    // oxlint-disable-next-line no-require-imports
    return require('react-native') as Views
  } catch {
    return {}
  }
}

type V = ComponentType<Record<string, unknown>>

// One L-shaped corner: two borders and a small radius on the bend; `grow` widens it for the dark edge behind.
const corner = (View: V, key: string, x: number, y: number, arm: number, thick: number, color: string, right: boolean, bottom: boolean) =>
  createElement(View, {
    key,
    pointerEvents: 'none',
    style: {
      position: 'absolute',
      left: x,
      top: y,
      width: arm,
      height: arm,
      borderColor: color,
      borderTopWidth: bottom ? 0 : thick,
      borderBottomWidth: bottom ? thick : 0,
      borderLeftWidth: right ? 0 : thick,
      borderRightWidth: right ? thick : 0,
      ...(bottom
        ? right
          ? { borderBottomRightRadius: RADIUS }
          : { borderBottomLeftRadius: RADIUS }
        : right
          ? { borderTopRightRadius: RADIUS }
          : { borderTopLeftRadius: RADIUS }),
    },
  })

/** Draws the outline `dial.highlight` asks for. Render it once, on top of the app (the dev bridge component returns it). */
export function DialsOverlay() {
  const view = useSyncExternalStore(watchHighlight, outlineView, outlineView)
  return drawOutline(views().View as V | undefined, view)
}

/** The element tree for the current outline; split out so tests can pass their own View. */
export function drawOutline(View: V | undefined, { rects, color, hidden }: OutlineView) {
  if (!View || hidden || !rects.length) return null
  return createElement(
    View,
    { pointerEvents: 'none', style: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } },
    ...rects.map((r, i) => {
      const w = r.width + OFFSET * 2
      const h = r.height + OFFSET * 2
      const x = r.x - OFFSET
      const y = r.y - OFFSET
      // Arms stay within a third of the side, so tiny rects keep four separate corners.
      const arm = Math.max(THICK * 2, Math.min(ARM, w / 3, h / 3))
      const spots = [
        [x, y, false, false],
        [x + w - arm, y, true, false],
        [x, y + h - arm, false, true],
        [x + w - arm, y + h - arm, true, true],
      ] as const
      return createElement(
        View,
        { key: i, pointerEvents: 'none', style: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 } },
        // A dark bracket 1 px larger sits behind the coloured one so it shows on light and dark screens.
        ...spots.flatMap(([cx, cy, right, bottom], n) => [
          corner(View, `d${n}`, cx - 1, cy - 1, arm + 2, THICK + 2, EDGE, right, bottom),
          corner(View, `c${n}`, cx, cy, arm, THICK, color, right, bottom),
        ]),
      )
    }),
  )
}
