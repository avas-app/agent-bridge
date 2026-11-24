import { cdpTransport, useAgentBridge } from '@avasapp/agent-bridge'
import { DialsOverlay, useDials } from '@avasapp/agent-bridge/dials'
import { expoTransport } from '@avasapp/agent-bridge/expo'
import { routerTools } from '@avasapp/agent-bridge/expo-router'
import { networkTools } from '@avasapp/agent-bridge/network'
import { queryTools } from '@avasapp/agent-bridge/tanstack-query'
import { storeTools } from '@avasapp/agent-bridge/zustand'
import { useQueryClient } from '@tanstack/react-query'
import { router, useNavigationContainerRef } from 'expo-router'

import { API_URL } from '@/api'
import { useAuth } from '@/auth'
import { realtimeDevTools } from '@/realtime'
import { useSettings } from '@/settings'
import { themes } from '@/theme'

import { hudTools } from './hud'
import { scenarios } from './scenarios'

export function AgentBridge() {
  const queryClient = useQueryClient()
  const query = queryTools(queryClient)
  useAgentBridge({
    name: 'sprout',
    transports: [expoTransport(), cdpTransport()],
    tools: {
      ...query,
      ...storeTools({ settings: useSettings, auth: useAuth }),
      ...routerTools(router, { navigation: useNavigationContainerRef() }),
      ...networkTools(),
      ...realtimeDevTools,
      ...hudTools,
      ...useDials({
        theme: {
          tokens: () => ({ colors: themes.light }),
          labels: {
            colors: 'Colours',
            'colors.text': 'Ink',
            'colors.accent': 'Leaf',
            'colors.accentSoft': 'Leaf tint',
            'colors.violetSoft': 'Lilac tint',
          },
          file: 'src/theme.ts',
        },
      }),
      // For flows/checks/logs.flow.mjs: errors come back with the next reply.
      'app.logError': (message: string) => console.error(message),
      'app.throwLater': () => {
        setTimeout(() => {
          throw new Error('boom from a timer')
        }, 0)
      },
      // For flows/checks/signed-in.flow.mjs: a request the app makes, from any path.
      'app.fetch': async (path: string) => {
        const res = await fetch(`${API_URL}${path}`)
        return { status: res.status, body: await res.text() }
      },
    },
    scenarios,
  })
  return <DialsOverlay />
}
