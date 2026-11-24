// Release build: every dial returns its default and nothing is registered.
const NoComponent = () => null
const isComponent = (v: unknown) => {
  if (typeof v === 'function') {
    const f = v as { name?: string; displayName?: string; prototype?: { isReactComponent?: unknown } }
    return !!f.prototype?.isReactComponent || /^[A-Z]/.test(f.displayName ?? f.name ?? '')
  }
  return !!v && typeof v === 'object' && '$$typeof' in (v as object)
}
const meta = <T>(_id: string, def: T) => def
export const dial = {
  color: meta<string>,
  number: meta<number>,
  enum: <T extends string>(_id: string, def: T, _options?: readonly T[]) => def,
  boolean: meta<boolean>,
  text: meta<string>,
  variant: <T>(_id: string, variants: Record<string, T>, def: string, _meta?: unknown): T => {
    const all = Object.values(variants)
    // Same rule as the dev build: only components get a host, and an unknown default renders nothing.
    if (!(def in variants) && all.length > 0 && all.every(isComponent)) return NoComponent as T
    return variants[def] as T
  },
  token: <T>(_id: string, _path: string, fallback: T) => fallback,
}
export const dialTools = () => ({})
export const useDials = () => ({})
export const DialsOverlay = () => null
