import { toJson } from '../runtime/to-json'

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

type Path = Array<string | number>

/** A path as dotted string ("auth.isLoggedIn") or array of segments. */
export function toPath(part: unknown): Path {
  if (typeof part === 'string') return part === '' ? [] : part.split('.')
  if (typeof part === 'number') return [part]
  if (
    Array.isArray(part) &&
    part.every((p) => typeof p === 'string' || typeof p === 'number')
  )
    return part
  throw new Error(
    `A path is a dotted string or an array of segments, got ${JSON.stringify(part)}`,
  )
}

export function at(value: unknown, path: Path): unknown {
  return path.reduce<unknown>(
    (v, k) => (v as Record<string, unknown> | undefined)?.[k],
    value,
  )
}

export const kindOf = (v: unknown) =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v

type GetOptions = { pick?: unknown[]; keys?: boolean }

// store.get("s", "a", "b.c", ["d"], { pick }): everything between the name
// and a trailing options object is the path.
export function readState(state: unknown, given: unknown[], tool = 'store.get'): unknown {
  // null and undefined mean no path or options.
  const args = given.filter((a) => a != null)
  const last = args.at(-1)
  const isOptions = isObject(last) && !Array.isArray(last)
  const options = (isOptions ? last : {}) as GetOptions
  const unknown = Object.keys(options).filter((k) => k !== 'pick' && k !== 'keys')
  if (unknown.length)
    throw new Error(
      `Unknown ${tool} option ${unknown.map((k) => `"${k}"`).join(', ')}. Options: pick, keys`,
    )
  const value = at(state, (isOptions ? args.slice(0, -1) : args).flatMap(toPath))
  if (options.pick !== undefined) {
    if (!Array.isArray(options.pick))
      throw new Error(`${tool} pick is an array of paths`)
    return Object.fromEntries(
      options.pick.map((p) => [
        Array.isArray(p) ? p.join('.') : String(p),
        at(value, toPath(p)),
      ]),
    )
  }
  if (options.keys)
    return isObject(value)
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, kindOf(v)]))
      : kindOf(value)
  return value
}

const PREVIEW = 200

// A value as bridge.pending shows it: small ones as they are, big ones cut.
// Cycles and BigInts print as toJson prints them; anything else that won't
// serialize shows as a marker, so one odd value never hides the store.
export function preview(value: unknown): unknown {
  try {
    const safe = toJson(value)
    const text = JSON.stringify(safe)
    if (text.length <= PREVIEW) return safe
    return `${text.slice(0, PREVIEW)}… (${text.length} chars)`
  } catch {
    return '[unserializable]'
  }
}

// What restore would change in a store: each key whose value differs from the
// snapshot, with both (redacted). Actions are left out; restore keeps the current ones.
export function differences(
  snapshot: unknown,
  current: unknown,
  show: (key: string, value: unknown) => unknown,
): Record<string, { snapshot: unknown; current: unknown }> {
  if (!isObject(snapshot) || !isObject(current)) return {}
  const out: Record<string, { snapshot: unknown; current: unknown }> = {}
  for (const k of new Set([...Object.keys(snapshot), ...Object.keys(current)])) {
    const a = snapshot[k]
    const b = current[k]
    if (typeof a === 'function' || typeof b === 'function') continue
    if (!Object.is(a, b))
      out[k] = { snapshot: preview(show(k, a)), current: preview(show(k, b)) }
  }
  return out
}

/**
 * Keeps secrets out of what store.* prints. Either dotted paths per store
 * (`{ auth: ['accessToken', 'user.phone'] }`), or a hook called for the store
 * value and every nested value with its dotted path; what it returns is
 * printed instead.
 *
 * Paths are store paths. A `store.call` result that is a piece of the store's
 * state (same object, e.g. `() => get().user`) is matched by where it lives; a
 * copy or derived value (`() => ({ ...get().user })`) is not, so its paths are
 * matched relative to the result and store paths like `user.phone` won't apply.
 * Use the hook, or don't return secrets from actions.
 */
export type Redact =
  | Record<string, string[]>
  | ((store: string, path: string, value: unknown) => unknown)

const REDACTED = '[redacted]'

export function redactValue(
  redact: Redact | undefined,
  name: string,
  value: unknown,
  path: string,
  seen: object[] = [],
): unknown {
  if (!redact || typeof value === 'function') return value
  if (typeof redact === 'function') {
    if (path) value = redact(name, path, value)
  } else if (
    path &&
    redact[name]?.some((p) => path === p || path.startsWith(`${p}.`))
  ) {
    return REDACTED
  }
  if (!isObject(value) || seen.includes(value)) return value
  const next = [...seen, value]
  const entries = Object.entries(value).map(([k, v]) => [
    k,
    redactValue(redact, name, v, path ? `${path}.${k}` : k, next),
  ])
  return Array.isArray(value)
    ? entries.map(([, v]) => v)
    : Object.fromEntries(entries)
}

/**
 * Keeps secrets out of what an adapter prints, by the name of the slice or
 * atom: dotted paths inside it (`{ auth: ['token', 'user.phone'] }`), or `true`
 * for all of it (`{ authToken: true }`). Or a hook called for the whole value
 * (path `''`) and every nested value with its dotted path; what it returns is
 * printed instead.
 */
export type NamedRedact =
  | Record<string, string[] | true>
  | ((name: string, path: string, value: unknown) => unknown)

export function redactNamed(
  redact: NamedRedact | undefined,
  name: string,
  value: unknown,
): unknown {
  if (!redact) return value
  if (typeof redact === 'function') {
    return redactValue(redact, name, redact(name, '', value), '')
  }
  const rule = redact[name]
  if (rule === true) return REDACTED
  return rule ? redactValue({ [name]: rule }, name, value, '') : value
}

const warned = new Set<string>()

/** Warns once per rule when a redact key names no slice or atom, since it would silently hide nothing. */
export function warnUnknownRedact(
  redact: NamedRedact | undefined,
  known: string[],
  adapter: string,
): void {
  if (!redact || typeof redact === 'function') return
  for (const key of Object.keys(redact)) {
    if (known.includes(key) || warned.has(`${adapter}:${key}`)) continue
    warned.add(`${adapter}:${key}`)
    console.warn(`[agent-bridge] ${adapter} redact key "${key}" matches no ${adapter === 'redux' ? 'slice' : 'atom'}, so it hides nothing. Known: ${known.join(', ')}`)
  }
}
