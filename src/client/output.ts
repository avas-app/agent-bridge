import { writeFile } from 'node:fs/promises'

/** Bigger results print as a summary unless --full or --out is given. */
export const OUTPUT_LIMIT_BYTES = 32 * 1024

const kb = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** What a value is, one level deep: `array(120)`, or each key of an object with its own type. */
export function shapeOf(value: unknown): unknown {
  const kind = (v: unknown): string =>
    Array.isArray(v)
      ? `array(${v.length})`
      : v === null
        ? 'null'
        : typeof v === 'object'
          ? `object(${Object.keys(v).length} keys)`
          : typeof v === 'string'
            ? `string(${v.length})`
            : typeof v
  if (Array.isArray(value)) {
    const first = value.length ? kind(value[0]) : undefined
    return { type: kind(value), ...(first && { first }) }
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, kind(v)]),
    )
  return { type: kind(value) }
}

export type RenderOptions = {
  out?: string
  full?: boolean
  limit?: number
  /** What `--out` names in the hint of a summary. */
  outKind?: 'file' | 'dir'
}

const fileSummary = (file: string, bytes: number, value: unknown) => ({
  file,
  bytes,
  size: kb(bytes),
  shape: shapeOf(value),
})

const tooLarge = (
  bytes: number,
  value: unknown,
  outKind: 'file' | 'dir' = 'file',
) => ({
  resultTooLarge: true,
  bytes,
  size: kb(bytes),
  shape: shapeOf(value),
  hint: `Not printed: the result is ${kb(bytes)}. Re-run with --out <${outKind === 'dir' ? 'dir' : 'file'}> to write it to a ${outKind === 'dir' ? 'file in that directory' : 'file'}, or --full to print it, or narrow the call (a path, a filter, a smaller page).`,
})

/** What `call` prints for a value, before formatting: the value itself, or, when it is big or goes to a file, a summary. */
export async function shapedResult(
  value: unknown,
  options: RenderOptions = {},
): Promise<unknown> {
  const json = JSON.stringify(value, null, 2) ?? 'null'
  const bytes = Buffer.byteLength(json)
  if (options.out) {
    await writeFile(options.out, `${json}\n`)
    return fileSummary(options.out, bytes, value)
  }
  if (options.full || bytes <= (options.limit ?? OUTPUT_LIMIT_BYTES))
    return value === undefined ? null : value
  return tooLarge(bytes, value, options.outKind)
}

/** The text `call` prints for a value: the JSON itself, or, when it is big, a summary that is JSON too. */
export async function renderResult(
  value: unknown,
  options: RenderOptions = {},
): Promise<string> {
  const json = JSON.stringify(value, null, 2) ?? 'null'
  const bytes = Buffer.byteLength(json)
  if (options.out) {
    await writeFile(options.out, `${json}\n`)
    return JSON.stringify(fileSummary(options.out, bytes, value), null, 2)
  }
  if (options.full || bytes <= (options.limit ?? OUTPUT_LIMIT_BYTES))
    return json
  return JSON.stringify(tooLarge(bytes, value), null, 2)
}
