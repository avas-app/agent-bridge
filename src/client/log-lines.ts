import type { LogEntry } from '../shared/protocol'

/** One terse line per entry: `! error during store.call: first line`. */
export function logLine(entry: LogEntry): string {
  const where = entry.during
    ? ` during ${entry.during}`
    : entry.after
      ? ` after ${entry.after}`
      : ''
  const first = entry.message.split('\n')[0] ?? ''
  const text = first.length > 300 ? `${first.slice(0, 300)}...` : first
  return `! ${entry.level}${where}: ${text}`
}
