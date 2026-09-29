// Walks React's committed fiber tree. Kept free of react-native imports so it
// can be tested with a fake tree, and so it bundles on web.

export type Fiber = {
  tag: number
  /** The host component's name on native ('RCTText'), or tag on web. */
  type?: unknown
  memoizedProps: unknown
  stateNode: unknown
  child: Fiber | null
  sibling: Fiber | null
  return: Fiber | null
}

export type Rect = { x: number; y: number; width: number; height: number }

export const HOST_COMPONENT = 5
export const HOST_TEXT = 6

type DevToolsHook = {
  renderers: Map<number, unknown>
  getFiberRoots: (rendererId: number) => Set<{ current: Fiber }>
}

export function fiberRoots(hook: DevToolsHook | undefined): Fiber[] {
  if (!hook?.getFiberRoots) return []
  const roots: Fiber[] = []
  for (const id of hook.renderers.keys()) {
    for (const root of hook.getFiberRoots(id)) roots.push(root.current)
  }
  return roots
}

type DomElement = {
  getBoundingClientRect: () => Rect
  checkVisibility?: () => boolean
  getClientRects?: () => { length: number }
}

type FabricUIManager = {
  measureInWindow: (
    shadowNode: unknown,
    callback: (x: number, y: number, width: number, height: number) => void,
  ) => void
}

/**
 * Where a host component is in the window, or null when it isn't displayed.
 * On web (react-dom, react-native-web) the host is a DOM element. On native,
 * Fabric's UIManager measures the shadow node synchronously in its latest
 * committed layout, and returns an empty rect for one that isn't laid out.
 */
export function measureHost(host: Fiber): Rect | null {
  const node = host.stateNode as DomElement | { node?: unknown } | null
  if (node && 'getBoundingClientRect' in node) {
    const displayed = node.checkVisibility
      ? node.checkVisibility()
      : (node.getClientRects?.().length ?? 1) > 0
    if (!displayed) return null
    const r = node.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }
  const ui = (globalThis as { nativeFabricUIManager?: FabricUIManager })
    .nativeFabricUIManager
  const shadowNode = (node as { node?: unknown } | null)?.node
  if (!ui || !shadowNode) return null
  let rect: Rect | null = null
  ui.measureInWindow(shadowNode, (x, y, width, height) => {
    rect = { x, y, width, height }
  })
  return rect
}

/**
 * The text a fiber renders and the host component that displays it. React
 * Native gives text its own fiber; react-dom puts a lone string child in the
 * host component's props instead.
 */
export function textOf(fiber: Fiber): { text: string; host: Fiber | null } | null {
  if (fiber.tag === HOST_TEXT && typeof fiber.memoizedProps === 'string') {
    let host = fiber.return
    while (host && host.tag !== HOST_COMPONENT) host = host.return
    return { text: fiber.memoizedProps, host }
  }
  const children = (fiber.memoizedProps as { children?: unknown } | null)
    ?.children
  if (
    fiber.tag === HOST_COMPONENT &&
    !fiber.child &&
    (typeof children === 'string' || typeof children === 'number')
  ) {
    return { text: String(children), host: fiber }
  }
  return null
}
