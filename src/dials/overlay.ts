import { type ComponentType, createElement, useSyncExternalStore } from 'react'

import { highlighted, watchHighlight } from './highlight'

const COLOR = '#C6F432'
const EDGE = 'rgba(11,11,12,0.85)'
const FILL = 'rgba(198,244,50,0.12)'
const BORDER = 2
const OFFSET = 4

type Views = { View?: unknown }
const views = (): Views => {
  try {
    // oxlint-disable-next-line no-require-imports
    return require('react-native') as Views
  } catch {
    return {}
  }
}

/** Draws the outline `dial.highlight` asks for. Render it once, on top of the app (the dev bridge component returns it). */
export function DialsOverlay() {
  const rects = useSyncExternalStore(watchHighlight, highlighted, highlighted)
  const View = views().View as ComponentType<Record<string, unknown>> | undefined
  if (!View || !rects.length) return null
  const grow = OFFSET + BORDER
  return createElement(
    View,
    { pointerEvents: 'none', style: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } },
    ...rects.map((r, i) =>
      // Dark rings either side of the lime one keep it visible on light and dark screens.
      createElement(
        View,
        {
          key: i,
          pointerEvents: 'none',
          style: {
            position: 'absolute',
            left: r.x - grow - 1,
            top: r.y - grow - 1,
            width: r.width + (grow + 1) * 2,
            height: r.height + (grow + 1) * 2,
            borderWidth: 1,
            borderColor: EDGE,
            borderRadius: 7,
          },
        },
        createElement(
          View,
          { pointerEvents: 'none', style: { flex: 1, borderWidth: BORDER, borderColor: COLOR, borderRadius: 6 } },
          createElement(View, {
            pointerEvents: 'none',
            style: { flex: 1, borderWidth: 1, borderColor: EDGE, borderRadius: 4, backgroundColor: FILL },
          }),
        ),
      ),
    ),
  )
}
