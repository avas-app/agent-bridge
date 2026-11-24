import * as React from 'react'
import { useEffect, useSyncExternalStore } from 'react'

import type { Tools } from '../runtime/types'
import {
  type Dial,
  type DialMeta,
  type DialTheme,
  type DialValue,
  type NumberMeta,
  type Spec,
  addOwner,
  apply,
  currentOwner,
  changed,
  list,
  register,
  reset,
  resolveToken,
  set,
  setTheme,
  subscribe,
  tokens,
} from './registry'

import { highlight, rects } from './highlight'

export { DialsOverlay } from './overlay'
export type { Dial, DialMeta, DialTheme, NumberMeta }
export type { DialRects } from './highlight'

export type DialsOptions = { theme?: DialTheme }

function read<T extends DialValue>(id: string, spec: Spec): T {
  const entry = register(id, spec)
  const owner = currentOwner(React)
  useEffect(() => (owner ? addOwner(id, owner) : undefined), [id])
  const value = useSyncExternalStore(
    subscribe(id),
    () => entry.value,
    () => entry.value,
  )
  entry.renders++
  return value as T
}

type Comp = React.ComponentType<Record<string, unknown>>
const isComponent = (v: unknown) =>
  typeof v === 'function' || (!!v && typeof v === 'object' && '$$typeof' in (v as object))

const hosts = new Map<string, Comp>()
const latest = new Map<string, { spec: Spec; variants: Record<string, Comp> }>()

// Component variants render through one stable host per dial, so each rendered
// instance (each card) is a reader to outline, not the screen that picked it.
function variantHost(id: string, spec: Spec, variants: Record<string, Comp>): Comp {
  register(id, spec)
  latest.set(id, { spec, variants })
  let Host = hosts.get(id)
  if (!Host) {
    Host = function DialVariant(props: Record<string, unknown>) {
      const now = latest.get(id)!
      const key = read<string>(id, now.spec)
      const C = now.variants[key] ?? now.variants[now.spec.def as string]
      return C ? React.createElement(C, props) : null
    }
    hosts.set(id, Host)
  }
  return Host
}

/** Tunable values the agent puts in app code. Release builds return the default. */
export const dial = {
  color: (id: string, def: string, meta?: DialMeta): string => read(id, { type: 'color', def, meta }),
  number: (id: string, def: number, meta?: NumberMeta): number => read(id, { type: 'number', def, meta }),
  enum: <T extends string>(id: string, def: T, options: readonly T[], meta?: DialMeta): T =>
    read(id, { type: 'enum', def, options: [...options], meta }),
  boolean: (id: string, def: boolean, meta?: DialMeta): boolean => read(id, { type: 'boolean', def, meta }),
  text: (id: string, def: string, meta?: DialMeta): string => read(id, { type: 'text', def, meta }),
  /** Pick one of `variants` by key: `dial.variant('card', { roomy: RoomyCard, tiles: TileCard }, 'roomy')`. */
  variant: <T>(id: string, variants: Record<string, T>, def: string, meta?: DialMeta): T => {
    const spec: Spec = { type: 'variant', def, options: Object.keys(variants), meta }
    if (Object.values(variants).every(isComponent)) return variantHost(id, spec, variants as Record<string, Comp>) as T
    const key = read<string>(id, spec)
    return (variants[key] ?? variants[def]) as T
  },
  /** The value of the picked theme token (starts at `tokenPath`), or `fallback` when it can't be resolved. */
  token: <T extends string | number>(id: string, tokenPath: string, fallback: T, meta?: DialMeta): T => {
    // The dial holds a token path; the user picks another path from the same group.
    const path = read<string>(id, { type: 'token', def: tokenPath, tokenPath, meta })
    const leaf = resolveToken(path)
    return (typeof leaf === 'string' || typeof leaf === 'number' ? leaf : fallback) as T
  },
}

const unwrapRun = (run: (...a: never[]) => unknown) => run as never

/**
 * The `dial.*` tools. Spread them into `useAgentBridge({ tools })`; `theme`
 * feeds `dial.token` and `dial.tokens`.
 */
export function dialTools(options: DialsOptions = {}): Tools {
  setTheme(options.theme)
  return {
    'dial.list': {
      description: 'Every dial: id, type, value, original, constraints, tokenPath and how often it rendered.',
      maxArgs: 0,
      run: () => list(),
    },
    'dial.set': {
      description: 'dial.set(id, value): change one dial live. Errors list the allowed values.',
      maxArgs: 2,
      run: unwrapRun((id: string, value: unknown) => set(id, value)),
    },
    'dial.apply': {
      description: 'dial.apply({id: value}): set many dials; ids with no dial yet are kept and reported as unknown.',
      maxArgs: 1,
      run: unwrapRun((values: Record<string, unknown>) => apply(values)),
    },
    'dial.reset': {
      description: 'dial.reset(id?): put one dial, or all, back to its original value.',
      maxArgs: 1,
      run: unwrapRun((id?: string) => reset(id)),
    },
    'dial.tokens': {
      description: 'The theme given to useDials as {tokens, labels}, or null.',
      maxArgs: 0,
      run: () => tokens(),
    },
    'dial.rects': {
      description: 'dial.rects(id): window-point rects of the first view of each mounted component reading the dial, plus the pixel ratio and window size.',
      maxArgs: 1,
      run: unwrapRun((id: string) => rects(id)),
    },
    'dial.highlight': {
      description: 'dial.highlight(id | null): outline the components reading the dial (needs <DialsOverlay/>); null clears.',
      maxArgs: 1,
      run: unwrapRun((id: string | null) => highlight(id ?? null)),
    },
    'dial.restore': {
      description: 'Put every dial back to its original value.',
      maxArgs: 0,
      run: () => ({ reset: reset().length }),
      pending: ({ detail } = {}) => {
        const ids = changed()
        return ids.length ? (detail ? ids : true) : false
      },
    },
  }
}

/**
 * Call once in the dev bridge file: `useAgentBridge({ tools: { ...useDials({ theme }) } })`.
 * It sets up the theme and returns the `dial.*` tools, so there is one call to
 * wire; it uses no React state, which makes it safe to call every render.
 */
export function useDials(options: DialsOptions = {}): Tools {
  return dialTools(options)
}
