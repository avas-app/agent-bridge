// Release build: listeners pass through untouched and there are no tools.
export const createRealtimeTap = () => ({
  wrap: <L>(_channel: string, listener: L) => ({
    listener,
    unsubscribe: () => {},
  }),
  tools: {},
})
