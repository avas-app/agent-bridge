import { type Area, deviceState } from './types'

/**
 * `device.setTime`: shift `Date.now()` and `new Date()`. Timers and
 * `performance.now` keep real time, so intervals and React's scheduler run as usual.
 */
export function clockArea(): Area {
  const restore = () => {
    const st = deviceState()
    if (!st.RealDate) return { restored: false }
    globalThis.Date = st.RealDate
    delete st.RealDate
    delete st.offsetMs
    return { restored: true }
  }

  const install = () => {
    const st = deviceState()
    const Real = (st.RealDate ??= globalThis.Date)
    const now = () => Real.now() + (deviceState().offsetMs ?? 0)
    globalThis.Date = new Proxy(Real, {
      construct: (target, args, newTarget) =>
        Reflect.construct(target, args.length ? args : [now()], newTarget),
      apply: () => new Real(now()).toString(),
      get: (target, key) => (key === 'now' ? now : Reflect.get(target, key)),
    })
  }

  return {
    pending: () => {
      const { RealDate, offsetMs } = deviceState()
      return RealDate ? { offsetMs, now: new Date().toISOString() } : null
    },
    restore,
    tools: {
      'device.setTime': {
        description:
          'Fake the clock: ["2026-12-25T09:00:00Z"] or [{ offsetMs: 86400000 }] shifts Date.now() and new Date() app-wide until device.restore. Timers, performance.now and values read earlier are not shifted, and react-query only rechecks staleness on its next trigger (follow with device.appState "active"). Returns { offsetMs, now }.',
        maxArgs: 1,
        run: (to: unknown) => {
          const st = deviceState()
          const real = (st.RealDate ?? Date).now()
          let offsetMs: number
          if (typeof to === 'string') {
            const at = (st.RealDate ?? Date).parse(to)
            if (Number.isNaN(at)) throw new Error('Pass an ISO date, e.g. "2026-12-25T09:00:00Z"')
            offsetMs = at - real
          } else if (to && typeof to === 'object' && Number.isFinite((to as { offsetMs?: number }).offsetMs))
            offsetMs = (to as { offsetMs: number }).offsetMs
          else throw new Error('Pass an ISO date or { offsetMs }')
          st.offsetMs = offsetMs
          if (!st.RealDate || globalThis.Date === st.RealDate) install()
          return { offsetMs, now: new Date().toISOString() }
        },
      },
    },
  }
}
