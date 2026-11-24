export type DialType = 'color' | 'number' | 'enum' | 'boolean' | 'text' | 'token'
export type DialValue = string | number | boolean

export type DialMeta = { label?: string; group?: string }
export type NumberMeta = DialMeta & { min?: number; max?: number; step?: number }

export type Dial = {
  id: string
  type: DialType
  value: DialValue
  original: DialValue
  label?: string
  group?: string
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
      if (!d.options?.includes(value as string)) bad(d.options!.map((o) => JSON.stringify(o)).join(', '))
      return value as string
    case 'boolean':
      if (typeof value !== 'boolean') bad('true, false')
      return value as boolean
    case 'text':
      if (typeof value !== 'string') bad('a string')
      return value as string
    case 'token':
      if (typeof value !== 'string' && typeof value !== 'number') bad('a string or number (a token value)')
      return value as DialValue
  }
}

export type Spec = {
  type: DialType
  def: DialValue
  meta?: DialMeta & { min?: number; max?: number; step?: number }
  options?: string[]
  tokenPath?: string
}

/** First registration fixes type, original and constraints; later ones return the same entry. */
export function register(id: string, spec: Spec): Entry {
  const existing = entries.get(id)
  if (existing) return existing
  const m = spec.meta ?? {}
  const entry: Entry = {
    id,
    type: spec.type,
    value: spec.def,
    original: spec.def,
    renders: 0,
    ...(m.label !== undefined && { label: m.label }),
    ...(m.group !== undefined && { group: m.group }),
    ...(m.min !== undefined && { min: m.min }),
    ...(m.max !== undefined && { max: m.max }),
    ...(m.step !== undefined && { step: m.step }),
    ...(spec.options && { options: [...spec.options] }),
    ...(spec.tokenPath !== undefined && { tokenPath: spec.tokenPath }),
  }
  entries.set(id, entry)
  if (entry.type === 'token') {
    const resolved = resolveToken(entry.tokenPath!)
    if (typeof resolved === 'string' || typeof resolved === 'number') entry.value = entry.original = resolved
  }
  if (held.has(id)) {
    try {
      entry.value = validate(entry, held.get(id))
      pushToken(entry)
    } catch {
      held.delete(id)
    }
  }
  return entry
}

const pushToken = (d: Entry) => {
  if (d.type === 'token') theme?.set?.(d.tokenPath!, d.value)
}

const emit = (id: string) => {
  for (const l of [...(listeners.get(id) ?? [])]) l()
  for (const l of [...anyListeners]) l()
}

export const subscribe = (id: string) => (cb: () => void) => {
  let set = listeners.get(id)
  if (!set) listeners.set(id, (set = new Set()))
  set.add(cb)
  return () => void set!.delete(cb)
}
export const subscribeAll = (cb: () => void) => {
  anyListeners.add(cb)
  return () => void anyListeners.delete(cb)
}

const publicDial = (e: Entry): Dial => {
  return { ...e, ...(e.options && { options: [...e.options] }) }
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
    pushToken(e)
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
  pushToken(e)
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

export function tokens(): unknown {
  if (!theme) return null
  try {
    return theme.tokens()
  } catch {
    return null
  }
}

/** For tests: forget everything. */
export function resetRegistry() {
  entries.clear()
  listeners.clear()
  anyListeners.clear()
  held.clear()
  theme = undefined
}
