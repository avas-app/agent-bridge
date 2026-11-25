export type DialType = 'color' | 'number' | 'enum' | 'boolean' | 'text' | 'token' | 'variant'
export type DialValue = string | number | boolean

export type DialMeta = { label?: string; group?: string; outline?: { color?: string } }
export type NumberMeta = DialMeta & { min?: number; max?: number; step?: number }

export type Dial = {
  id: string
  type: DialType
  value: DialValue
  original: DialValue
  label?: string
  group?: string
  /** Colour of this dial's device outline, when it sets one. */
  outline?: { color?: string }
  min?: number
  max?: number
  step?: number
  options?: string[]
  tokenPath?: string
  /** How many times a component read this dial; a re-render of a reader adds one. */
  renders: number
}

export type DialTheme = {
  tokens(): object
  /** Names for the panel: a token path or a group prefix ('colors') to a label. */
  labels?: Record<string, string>
  set?(path: string, value: unknown): void
  file?: string
}

type Entry = Dial

const entries = new Map<string, Entry>()
const listeners = new Map<string, Set<() => void>>()
const anyListeners = new Set<() => void>()
// Values the agent applied before their dial mounted; the dial takes it on first registration.
const held = new Map<string, DialValue>()
let theme: DialTheme | undefined

export const setTheme = (t: DialTheme | undefined) => {
  theme = t
}
export const getTheme = () => theme

const COLOR = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|hsl)a?\(.+\)|[a-z]+)$/i

/** Leaf token paths in the same top-level group as `path` (colors.* for colors.accent). */
export function tokenPaths(path: string): string[] {
  const top = path.split('.')[0]!
  const out: string[] = []
  const walk = (node: unknown, at: string) => {
    if (typeof node === 'string' || typeof node === 'number') out.push(at)
    else if (node && typeof node === 'object')
      for (const [k, v] of Object.entries(node)) walk(v, `${at}.${k}`)
  }
  walk(resolveToken(top), top)
  return out
}

export function resolveToken(path: string): unknown {
  let node: unknown
  try {
    node = theme?.tokens()
  } catch {
    return undefined
  }
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** Throws with the allowed values when `value` does not fit the dial. */
export function validate(d: Dial, value: unknown): DialValue {
  const bad = (allowed: string) => {
    throw new Error(`dial ${d.id} (${d.type}): ${JSON.stringify(value)} is not valid; allowed: ${allowed}`)
  }
  switch (d.type) {
    case 'color':
      if (typeof value !== 'string' || !COLOR.test(value.trim())) bad('a color: #rgb, #rrggbb, #rrggbbaa, rgb()/rgba(), hsl()/hsla() or a name')
      return (value as string).trim()
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) bad('a finite number')
      const n = value as number
      if ((d.min !== undefined && n < d.min) || (d.max !== undefined && n > d.max))
        bad(`a number from ${d.min ?? '-Infinity'} to ${d.max ?? 'Infinity'}`)
      return n
    }
    case 'enum':
    case 'variant':
      if (!d.options?.includes(value as string)) bad(d.options!.map((o) => JSON.stringify(o)).join(', '))
      return value as string
    case 'boolean':
      if (typeof value !== 'boolean') bad('true, false')
      return value as boolean
    case 'text':
      if (typeof value !== 'string') bad('a string')
      return value as string
    case 'token': {
      const leaf = typeof value === 'string' ? resolveToken(value) : undefined
      if (typeof leaf !== 'string' && typeof leaf !== 'number') bad(tokenPaths(d.tokenPath!).join(', ') || 'a token path')
      return value as string
    }
  }
}

export type Spec = {
  type: DialType
  def: DialValue
  meta?: DialMeta & { min?: number; max?: number; step?: number }
  options?: string[]
  tokenPath?: string
}

const sameList = (a?: string[], b?: string[]) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]))

/** Later registrations (Fast Refresh) update constraints and options, never the value or original. */
function refresh(e: Entry, spec: Spec) {
  const m = spec.meta ?? {}
  const next = { label: m.label, group: m.group, outline: m.outline, min: m.min, max: m.max, step: m.step } as Record<string, unknown>
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) delete (e as Record<string, unknown>)[k]
    else (e as Record<string, unknown>)[k] = v
  }
  if (spec.options && !sameList(e.options, spec.options)) {
    e.options = [...spec.options]
    if (!e.options.includes(e.value as string)) e.value = e.options.includes(e.original as string) ? e.original : e.value
  }
  if (spec.tokenPath !== undefined) e.tokenPath = spec.tokenPath
}

/** First registration fixes type, original and constraints; later ones return the same entry. */
export function register(id: string, spec: Spec): Entry {
  const existing = entries.get(id)
  const m = spec.meta ?? {}
  if (existing) {
    refresh(existing, spec)
    return existing
  }
  const entry: Entry = {
    id,
    type: spec.type,
    value: spec.def,
    original: spec.def,
    renders: 0,
    ...(m.label !== undefined && { label: m.label }),
    ...(m.group !== undefined && { group: m.group }),
    ...(m.outline !== undefined && { outline: m.outline }),
    ...(m.min !== undefined && { min: m.min }),
    ...(m.max !== undefined && { max: m.max }),
    ...(m.step !== undefined && { step: m.step }),
    ...(spec.options && { options: [...spec.options] }),
    ...(spec.tokenPath !== undefined && { tokenPath: spec.tokenPath }),
  }
  entries.set(id, entry)
  if (held.has(id)) {
    try {
      entry.value = validate(entry, held.get(id))
    } catch {
      // keep the default
    }
    held.delete(id)
  }
  return entry
}

const emit = (id: string) => {
  for (const l of [...(listeners.get(id) ?? [])]) l()
  for (const l of [...anyListeners]) l()
}

const subscribers = new Map<string, (cb: () => void) => () => void>()
/** One function per id: a new one each render would make useSyncExternalStore resubscribe every render. */
export const subscribe = (id: string) => {
  let fn = subscribers.get(id)
  if (!fn) {
    fn = (cb) => {
      let set = listeners.get(id)
      if (!set) listeners.set(id, (set = new Set()))
      set.add(cb)
      return () => void set!.delete(cb)
    }
    subscribers.set(id, fn)
  }
  return fn
}
export const subscribeAll = (cb: () => void) => {
  anyListeners.add(cb)
  return () => void anyListeners.delete(cb)
}

const publicDial = (e: Entry): Dial => {
  return { ...e, ...(e.options && { options: [...e.options] }), ...(e.outline && { outline: { ...e.outline } }) }
}

export const list = (): Dial[] => [...entries.values()].map(publicDial)

export function get(id: string): Entry {
  const e = entries.get(id)
  if (!e) throw new Error(`No dial "${id}". Known: ${[...entries.keys()].join(', ') || '(none)'}`)
  return e
}

export function set(id: string, value: unknown): Dial {
  const e = get(id)
  const next = validate(e, value)
  if (!Object.is(e.value, next)) {
    e.value = next
    emit(id)
  }
  return publicDial(e)
}

export function apply(values: Record<string, unknown>) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('dial.apply takes an object of id: value')
  const applied: string[] = []
  const unknown: string[] = []
  const invalid: { id: string; error: string }[] = []
  for (const [id, value] of Object.entries(values)) {
    const e = entries.get(id)
    if (!e) {
      held.set(id, value as DialValue)
      unknown.push(id)
      continue
    }
    try {
      set(id, value)
      applied.push(id)
    } catch (error) {
      invalid.push({ id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return invalid.length ? { applied, unknown, invalid } : { applied, unknown }
}

const putBack = (e: Entry) => {
  held.delete(e.id)
  if (Object.is(e.value, e.original)) return false
  e.value = e.original
  emit(e.id)
  return true
}

export function reset(id?: string): Dial[] {
  if (id !== undefined) {
    const e = get(id)
    putBack(e)
    return [publicDial(e)]
  }
  for (const e of entries.values()) putBack(e)
  held.clear()
  return list()
}

export const changed = (): string[] => [
  ...[...entries.values()].filter((e) => !Object.is(e.value, e.original)).map((e) => e.id),
  ...held.keys(),
]

export function tokens(): { tokens: unknown; labels: Record<string, string> } | null {
  if (!theme) return null
  try {
    return { tokens: theme.tokens(), labels: { ...theme.labels } }
  } catch {
    return null
  }
}

// Fibers of the mounted components that read each dial; the panel outlines their first host view.
const owners = new Map<string, Set<object>>()

export function addOwner(id: string, fiber: object): () => void {
  let set = owners.get(id)
  if (!set) owners.set(id, (set = new Set()))
  set.add(fiber)
  return () => void owners.get(id)?.delete(fiber)
}
export const ownersOf = (id: string): object[] => [...(owners.get(id) ?? [])]

/** The fiber React is rendering now. Dev builds only; null when React hides it. */
export function currentOwner(react: unknown): object | null {
  try {
    const internals = (react as Record<string, unknown>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE as
      | { A?: { getOwner?: () => unknown } | null }
      | undefined
    const owner = internals?.A?.getOwner?.()
    return owner && typeof owner === 'object' ? owner : null
  } catch {
    return null
  }
}

/** For tests: forget everything. */
export function resetRegistry() {
  entries.clear()
  listeners.clear()
  subscribers.clear()
  owners.clear()
  anyListeners.clear()
  held.clear()
  theme = undefined
}
