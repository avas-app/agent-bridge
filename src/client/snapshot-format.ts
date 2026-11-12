/**
 * `call` and the MCP server print screen.snapshot as one line per element unless
 * the caller picked a format. The runtime tool itself still returns JSON by default,
 * so `bridge.call('screen.snapshot')` and flows get structured data.
 */
export function withCompactSnapshot(tool: string, args: unknown[], json = false): unknown[] {
  if (tool !== 'screen.snapshot' || args.length > 1) return args
  const options = args[0]
  if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options)))
    return args
  const given = (options ?? {}) as Record<string, unknown>
  if (given.format !== undefined) return args
  return [{ ...given, format: json ? 'json' : 'text' }]
}

/** A snapshot already in text prints as it is, not as a quoted JSON string. */
export const isSnapshotText = (tool: string, value: unknown): value is string =>
  tool === 'screen.snapshot' && typeof value === 'string'
