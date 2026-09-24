// The slice of react-native the runtime uses, so this repo can typecheck
// without installing React Native. Apps get the real types.
declare module 'react-native' {
  export const Dimensions: {
    get(dimension: 'window' | 'screen'): { width: number; height: number }
  }
  export const Platform: { OS: string }
}
