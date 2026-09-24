import { Platform, useColorScheme } from 'react-native'

import { useSettings } from './settings'

const light = {
  background: '#F5F4EF',
  card: '#FFFFFF',
  text: '#15181C',
  muted: '#6D727A',
  border: '#E6E3DB',
  subtle: '#EFEDE6',
  accent: '#2E7D57',
  accentSoft: '#E2F0E8',
  danger: '#D0453E',
  dangerSoft: '#FBE7E5',
  info: '#2F6FD0',
  infoSoft: '#E4EDFB',
  amber: '#B7791F',
  amberSoft: '#FBF0DC',
  violet: '#7456C9',
  violetSoft: '#EEE9FB',
}

const dark: typeof light = {
  background: '#0D0F10',
  card: '#181B1D',
  text: '#F1F2F3',
  muted: '#8D939A',
  border: '#262A2D',
  subtle: '#202427',
  accent: '#5CC68F',
  accentSoft: '#17302A',
  danger: '#F07068',
  dangerSoft: '#3A1D1B',
  info: '#6FA3F2',
  infoSoft: '#18263B',
  amber: '#E3B04B',
  amberSoft: '#352A14',
  violet: '#A48BF0',
  violetSoft: '#271F3D',
}

export type Colors = typeof light
export type Tint = 'accent' | 'danger' | 'info' | 'amber' | 'violet'

export const mono = Platform.select({ ios: 'Menlo', default: 'monospace' })

export function useScheme(): 'light' | 'dark' {
  const system = useColorScheme()
  const theme = useSettings((s) => s.theme)
  if (theme !== 'system') return theme
  return system === 'dark' ? 'dark' : 'light'
}

export function useColors(): Colors {
  return useScheme() === 'dark' ? dark : light
}

export function tint(c: Colors, name: Tint) {
  return { fg: c[name], bg: c[`${name}Soft`] }
}
