// Release build: every dial returns its default and nothing is registered.
const meta = <T>(_id: string, def: T) => def
export const dial = {
  color: meta<string>,
  number: meta<number>,
  enum: <T extends string>(_id: string, def: T, _options?: readonly T[]) => def,
  boolean: meta<boolean>,
  text: meta<string>,
  variant: <T>(_id: string, variants: Record<string, T>, def: string, _meta?: unknown) => variants[def] as T,
  token: <T>(_id: string, _path: string, fallback: T) => fallback,
}
export const dialTools = () => ({})
export const useDials = () => ({})
export const DialsOverlay = () => null
