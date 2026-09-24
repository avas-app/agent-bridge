import { create } from 'zustand'

export type Theme = 'light' | 'dark' | 'system'

type Settings = {
  theme: Theme
  reminders: boolean
  setTheme: (theme: Theme) => void
  setReminders: (on: boolean) => void
}

export const useSettings = create<Settings>()((set) => ({
  theme: 'system',
  reminders: true,
  setTheme: (theme) => set({ theme }),
  setReminders: (reminders) => set({ reminders }),
}))
