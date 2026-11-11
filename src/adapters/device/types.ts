import type { Tools } from '../../runtime/types'

// oxlint-disable-next-line no-explicit-any -- structural stand-ins for modules the app owns
type Fn = (...args: any[]) => any

/** The parts of `react-native` the device tools use. Defaults to `require('react-native')`. */
export type ReactNativeLike = {
  Linking: { getInitialURL: Fn }
  AppState: { currentState: string }
  DeviceEventEmitter: { emit: Fn; listenerCount?: Fn }
  Platform?: { OS: string }
}

/** `@react-native-community/netinfo`'s default export. */
export type NetInfoLike = { refresh?: Fn }

/** `expo-notifications`. Only its default action id is read. */
export type NotificationsLike = { DEFAULT_ACTION_IDENTIFIER?: string }

export type DeviceToolsOptions = {
  /** NetInfo, so `device.offline` also flips it. Leave out if the app has none. */
  NetInfo?: NetInfoLike
  /** `import * as Notifications from 'expo-notifications'`. Adds `device.notification`. */
  Notifications?: NotificationsLike
  /** `useNavigationContainerRef()` from expo-router. Makes `device.openUrl` return the route it ended on. */
  navigation?: import('../expo-router').NavigationLike
  /** Adds `device.setTime`, which fakes `Date.now()` and `new Date()` app-wide. Off by default. */
  time?: boolean
  /** Override where Linking, AppState and the emitter come from. For tests. */
  reactNative?: ReactNativeLike
}

/** One area of device tools: its tools, what it would undo, and how. */
export type Area = {
  tools: Tools
  pending: () => Record<string, unknown> | null
  restore: () => Record<string, unknown>
}

// On globalThis, so a reloaded module (Fast Refresh) still sees what is faked
// and puts back the real function, not a patched copy.
const KEY = Symbol.for('@avasapp/agent-bridge/device')

export type DeviceState = {
  initialUrl?: string
  origGetInitialURL?: Fn
  appState?: { fake: string; real: string }
  offline?: boolean
  RealDate?: DateConstructor
  offsetMs?: number
}

export function deviceState(): DeviceState {
  const g = globalThis as unknown as Record<symbol, DeviceState | undefined>
  return (g[KEY] ??= {})
}

export function loadReactNative(): ReactNativeLike {
  return require('react-native') as ReactNativeLike
}
