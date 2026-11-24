import { type ComponentType, createElement, useSyncExternalStore } from 'react'

import { highlighted, watchHighlight } from './highlight'

const COLOR = '#C6F432'
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
      createElement(View, {
        key: i,
        pointerEvents: 'none',
        style: {
          position: 'absolute',
          left: r.x - grow,
          top: r.y - grow,
          width: r.width + grow * 2,
          height: r.height + grow * 2,
          borderWidth: BORDER,
          borderColor: COLOR,
          borderRadius: 6,
        },
      }),
    ),
  )
}
