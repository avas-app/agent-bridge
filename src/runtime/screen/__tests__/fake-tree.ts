// Fake fiber trees for the screen tests. Hosts are DOM-like, as in
// find-text-core's tests; composites are function components (tag 0).
import type { Fiber, Rect } from '../../find-text-core'

export const WINDOW = { width: 400, height: 800 }
export const RECT: Rect = { x: 20, y: 200, width: 120, height: 40 }

export function host(props: Record<string, unknown> = {}, rect: Rect | null = RECT): Fiber {
  return {
    tag: 5,
    memoizedProps: props,
    stateNode: rect ? { getBoundingClientRect: () => rect, checkVisibility: () => true } : null,
    child: null,
    sibling: null,
    return: null,
  }
}

export function composite(props: Record<string, unknown> = {}): Fiber {
  return { tag: 0, memoizedProps: props, stateNode: null, child: null, sibling: null, return: null }
}

export function text(content: string): Fiber {
  return { tag: 6, memoizedProps: content, stateNode: null, child: null, sibling: null, return: null }
}

/** Links parent -> children (as a sibling chain) and each child -> parent. */
export function tree(parent: Fiber, ...children: Fiber[]): Fiber {
  parent.child = children[0] ?? null
  children.forEach((c, i) => {
    c.return = parent
    c.sibling = children[i + 1] ?? null
  })
  return parent
}

/** React Native's <Text>: a composite over a host with text children. */
export const rnText = (content: string, props: Record<string, unknown> = {}) =>
  tree(composite(props), tree(host(props), text(content)))

/** A Pressable: the composite has onPress, the host View gets the rest. */
export function pressable(props: Record<string, unknown>, ...children: Fiber[]): Fiber {
  const { onPress, onPressIn, onPressOut, ...rest } = props
  void onPress
  void onPressIn
  void onPressOut
  return tree(composite(props), tree(host(rest), ...children))
}

/** A TextInput: composite and host both carry the input props. */
export const textInput = (props: Record<string, unknown>) => tree(composite(props), host(props))

type Root = { current: Fiber; pendingLanes?: number; suspendedLanes?: number }

/** Installs a fake DevTools hook; `commit()` plays React committing a root. */
export function installHook(roots: Root[]) {
  const g = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }
  const original: unknown[][] = []
  const hook = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: () => new Set(roots),
    onCommitFiberRoot: (...args: unknown[]) => {
      original.push(args)
    },
  }
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook
  return {
    hook,
    original,
    commit: (root = roots[0]) => hook.onCommitFiberRoot(1, root),
    remove: () => {
      delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__
    },
  }
}
