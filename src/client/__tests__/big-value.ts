/** A value of about `bytes` of JSON with newlines, quotes, emoji and separators inside strings. */
export function bigValue(bytes: number) {
  const row = `line one\nline "two"\r\n ${String.fromCodePoint(0x1f697)}\t`
  const rows: Array<{ i: number; text: string }> = []
  let size = 0
  for (let i = 0; size < bytes; i++) {
    rows.push({ i, text: row + i })
    size += JSON.stringify(rows[i]).length + 1
  }
  return { rows }
}
