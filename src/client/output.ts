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
    return JSON.stringify(
      { file: options.out, bytes, size: kb(bytes), shape: shapeOf(value) },
      null,
      2,
    )
  }
  if (options.full || bytes <= (options.limit ?? OUTPUT_LIMIT_BYTES))
    return json
  return JSON.stringify(
    {
      resultTooLarge: true,
      bytes,
      size: kb(bytes),
      shape: shapeOf(value),
      hint: `Not printed: the result is ${kb(bytes)}. Re-run with --out <file> to write it to a file, or --full to print it, or narrow the call (a path, a filter, a smaller page).`,
    },
    null,
    2,
  )
}
