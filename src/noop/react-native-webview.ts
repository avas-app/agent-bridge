export const useWebViewTools = () => ({
  props: {},
  wrap: <T>(onMessage?: T): T | undefined => onMessage,
})
export const webviewTools = () => ({})
