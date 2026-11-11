import type { ResultMessage } from '../../shared/protocol'

type Areas = Record<string, unknown>
type AdoptReply = Record<
  string,
  {
    adopted?: string[]
    already?: string[]
    changed?: string[]
    invalid?: string[]
    skipped?: string[]
    notKept?: string[]
    retry?: unknown
    error?: string
  }
>

const MAX_TRIES = 3

const plain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Folds `data` into `carry`: area, then store or instance name, then key. The older entry wins on a clash (it holds the true original). */
function merge(carry: Areas, data: Areas) {
  for (const [area, part] of Object.entries(data)) {
    const old = carry[area]
    if (!plain(old) || !plain(part)) {
      carry[area] = part
      continue
    }
    const next = { ...old }
    for (const [name, value] of Object.entries(part)) {
      const was = old[name]
      next[name] = plain(was) && plain(value) ? { ...value, ...was } : value
    }
    carry[area] = next
  }
}

/** The names under an area's journal part (stores or instances), for messages. */
const names = (part: unknown) => (plain(part) ? Object.keys(part) : [])

/**
 * What the app could undo from persistent storage, kept here because the app's
 * own memory (and its storage) are what a reload throws away. Raw values, so
 * it stays in memory: never logged, never written to the state file.
 * The app sends it on the reply of the call that changed it.
 */
export function createJournal(
  call: (tool: string, args: unknown[]) => Promise<ResultMessage>,
  firstLoad?: string,
) {
  let data: Areas = {}
  // `loadId:rev` of what `data` holds; '' when nothing yet.
  let tag = ''
  // The load `data` belongs to.
  let load = firstLoad
  // The journal of a load that is gone, waiting to be adopted by the new one.
  const carry: Areas = {}
  let tries = 0
  let lastWaiting = ''

  const why = (area: string, part: unknown, reason: (n: string) => string) => {
    const keys = names(part)
    return keys.length ? keys.map((n) => `${area}:${n} (${reason(n)})`) : [`${area} (${reason(area)})`]
  }
  const gaveUp = (reasons: Record<string, string>) => {
    const left = Object.entries(carry).flatMap(([area, part]) =>
      why(area, part, () => reasons[area] ?? 'not ready'),
    )
    for (const k of Object.keys(carry)) delete carry[k]
    return left.length ? `could not re-arm after the reload: ${left.join(', ')}` : ''
  }

  return {
    /** The tag to send with every call. */
    ack: () => tag,
    /** Takes the journal a reply carries; one from another load is dropped. */
    accept(r: ResultMessage) {
      if (r.journalData === undefined || !r.loadId || r.loadId !== load) return
      data = r.journalData
      tag = `${r.loadId}:${r.journal ?? 0}`
    },
    /** The app reloaded into `newLoad`: what the old load held moves to `carry`. Returns the pending areas that had nothing persistent. */
    reloaded(lastPending: string[], newLoad?: string): string[] {
      merge(carry, data)
      data = {}
      tag = ''
      load = newLoad
      tries = 0
      lastWaiting = ''
      return lastPending.filter((area) => !(area in carry))
    },
    hasCarry: () => Object.keys(carry).length > 0,
    /** Hands `carry` to the new load. Resolves to a note ('' when there was nothing to say). */
    async adopt(): Promise<string> {
      if (!Object.keys(carry).length) return ''
      const sent = structuredClone(carry)
      const sentLoad = load
      let r: ResultMessage
      try {
        r = await call('bridge.adopt', [sent])
      } catch {
        return '' // Lost connection: not a try.
      }
      if (r.loadId && sentLoad && r.loadId !== sentLoad) return ''
      this.accept(r)
      tries += 1
      const bits: string[] = []
      const reasons: Record<string, string> = {}
      if (!r.ok) {
        for (const area of Object.keys(sent)) reasons[area] = r.error
      } else {
        const reply = r.value as AdoptReply
        const adopted: string[] = []
        const already: string[] = []
        const changed: string[] = []
        const invalid: string[] = []
        const skipped: string[] = []
        const notKept: string[] = []
        for (const area of Object.keys(sent)) {
          const part = reply[area]
          if (!part) continue
          adopted.push(...(part.adopted ?? []))
          already.push(...(part.already ?? []))
          changed.push(...(part.changed ?? []))
          invalid.push(...(part.invalid ?? []))
          skipped.push(...(part.skipped ?? []))
          notKept.push(...(part.notKept ?? []))
          if (part.retry !== undefined) {
            carry[area] = part.retry
            reasons[area] = part.error ?? 'not ready'
          } else delete carry[area]
        }
        if (adopted.length)
          bits.push(`kept ${adopted.length} undo${adopted.length === 1 ? '' : 's'} across the reload (${adopted.join(', ')}); bridge.restore still puts them back`)
        if (already.length) bits.push(`already back to the original: ${already.join(', ')}`)
        if (changed.length) bits.push(`left alone, the app changed them since: ${changed.join(', ')}`)
        if (skipped.length) bits.push(`left alone, a different storage instance than the one you wrote: ${skipped.join(', ')}`)
        if (notKept.length) bits.push(`not kept across reload (not plain JSON, or renamed by partialize): ${notKept.join(', ')}`)
        if (invalid.length) bits.push(`ignored, not a value this session saved: ${invalid.join(', ')}`)
      }
      if (Object.keys(carry).length) {
        if (tries >= MAX_TRIES) {
          bits.push(gaveUp(reasons))
          lastWaiting = ''
        } else {
          const waiting = Object.entries(carry)
            .flatMap(([area, part]) => why(area, part, () => reasons[area] ?? 'not ready'))
            .join(', ')
          if (waiting !== lastWaiting) bits.push(`not ready yet, will retry: ${waiting}`)
          lastWaiting = waiting
        }
      }
      return bits.join('; ')
    },
    /** At session end: drops what is still waiting and says so. */
    giveUp: () => gaveUp({}),
  }
}
