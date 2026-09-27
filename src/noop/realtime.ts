// Release build: listeners pass through untouched, clients are left alone and
// there are no tools.
export const createRealtimeTap = () => ({
  wrap: <L>(_channel: string, listener: L) => ({
    listener,
    unsubscribe: () => {},
  }),
  tools: {},
})
export const tapListeners = (): void => {}
export const fakeableConnection = (): undefined => undefined
export const realtimeAdapter = () => () => ({})
