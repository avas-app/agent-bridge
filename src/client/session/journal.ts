import type { ResultMessage } from '../../shared/protocol'

type Areas = Record<string, unknown>
type AdoptReply = Record<
  string,
  { adopted?: string[]; already?: string[]; changed?: string[]; retry?: unknown }
>

/**
 * What the app could undo from persistent storage, kept here because the app's
 * own memory (and its storage) are what a reload throws away. Raw values, so
 * it stays in memory: never logged, never written to the state file.
 */
export function createJournal(
  call: (tool: string, args: unknown[]) => Promise<ResultMessage>,
) {
  let data: Areas = {}
  // -1: unknown, read it on the next reply.
  let knownRev = 0
  // The journal of a load that is gone, waiting to be adopted by the new one.
  let carry: Areas = {}
  let adopting: Promise<string> | null = null

  const read = async (): Promise<void> => {
    try {
      const r = await call('bridge.journal', [])
      if (r.ok) data = r.value as Areas
    } catch {
      knownRev = -1
    }
  }

  return {
    /** Reads the app's journal when its reply says it changed. */
    async afterReply(r: ResultMessage, force = false) {
      const rev = r.journal ?? 0
      if (!force && rev === knownRev) return
      knownRev = rev
      await read()
    },
    /** Reads the journal now, whatever the app last said. */
    refresh: () => read(),
    /**
     * The app reloaded: what the old load held moves to `carry`. Returns the
     * pending areas that had nothing persistent, so they are lost.
     */
    reloaded(lastPending: string[]): string[] {
      carry = { ...carry, ...data }
      data = {}
      knownRev = 0
      return lastPending.filter((area) => !(area in carry))
    },
    hasCarry: () => Object.keys(carry).length > 0,
    /** Hands `carry` to the new load. One at a time; resolves to a note ('' when there was nothing to say). */
    adopt(): Promise<string> {
      if (!Object.keys(carry).length) return Promise.resolve('')
      adopting ??= (async () => {
        const sent = carry
        let reply: AdoptReply | undefined
        try {
          const r = await call('bridge.adopt', [sent])
          if (r.ok) reply = r.value as AdoptReply
        } catch {
          // Lost connection: keep the journal for the next try.
        }
        if (!reply) return ''
        const adopted: string[] = []
        const already: string[] = []
        const changed: string[] = []
        const next: Areas = { ...carry }
        for (const area of Object.keys(sent)) {
          const part = reply[area]
          if (!part) continue
          adopted.push(...(part.adopted ?? []))
          already.push(...(part.already ?? []))
          changed.push(...(part.changed ?? []))
          if (part.retry !== undefined) next[area] = part.retry
          else delete next[area]
        }
        carry = next
        await read()
        const bits: string[] = []
        if (adopted.length) bits.push(`kept ${adopted.length} undo${adopted.length === 1 ? '' : 's'} across the reload (${adopted.join(', ')}); bridge.restore still puts them back`)
        if (already.length) bits.push(`already back to the original: ${already.join(', ')}`)
        if (changed.length) bits.push(`left alone, the app changed them since: ${changed.join(', ')}`)
        const waiting = Object.keys(carry)
        if (waiting.length) bits.push(`not ready yet, will retry: ${waiting.join(', ')}`)
        return bits.join('; ')
      })().finally(() => {
        adopting = null
      })
      return adopting
    },
    /** Waits for an adopt in flight. */
    idle: () => adopting?.then(() => {}, () => {}),
    /** Areas still waiting when the session ends. */
    waiting: () => Object.keys(carry),
  }
}
