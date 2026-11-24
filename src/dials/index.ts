import { useSyncExternalStore } from 'react'

import type { Tools } from '../runtime/types'
import {
  type Dial,
  type DialMeta,
  type DialTheme,
  type DialValue,
  type NumberMeta,
  type Spec,
  apply,
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

export type { Dial, DialMeta, DialTheme, NumberMeta }

export type DialsOptions = { theme?: DialTheme }

function read<T extends DialValue>(id: string, spec: Spec): T {
  const entry = register(id, spec)
  const value = useSyncExternalStore(
    subscribe(id),
    () => entry.value,
    () => entry.value,
  )
  entry.renders++
  return value as T
}

/** Tunable values the agent puts in app code. Release builds return the default. */
export const dial = {
  color: (id: string, def: string, meta?: DialMeta): string => read(id, { type: 'color', def, meta }),
  number: (id: string, def: number, meta?: NumberMeta): number => read(id, { type: 'number', def, meta }),
  enum: <T extends string>(id: string, def: T, options: readonly T[], meta?: DialMeta): T =>
    read(id, { type: 'enum', def, options: [...options], meta }),
  boolean: (id: string, def: boolean, meta?: DialMeta): boolean => read(id, { type: 'boolean', def, meta }),
  text: (id: string, def: string, meta?: DialMeta): string => read(id, { type: 'text', def, meta }),
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
      description: 'The theme token tree given to useDials, or null.',
      maxArgs: 0,
      run: () => tokens(),
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
