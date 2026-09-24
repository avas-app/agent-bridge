import { cdpTransport, useAgentBridge } from '@avasapp/agent-bridge'
import { expoTransport } from '@avasapp/agent-bridge/expo'
import { routerTools } from '@avasapp/agent-bridge/expo-router'
import { queryTools } from '@avasapp/agent-bridge/tanstack-query'
import { storeTools } from '@avasapp/agent-bridge/zustand'
import { useQueryClient } from '@tanstack/react-query'
import { router, useNavigationContainerRef } from 'expo-router'

import { useSettings } from '@/settings'

import { hudTools } from './hud'

export function AgentBridge() {
  const queryClient = useQueryClient()
  const query = queryTools(queryClient)
  useAgentBridge({
    name: 'sprout',
    transports: [expoTransport(), cdpTransport()],
    tools: {
      ...query,
      ...storeTools({ settings: useSettings }),
      ...routerTools(router, { navigation: useNavigationContainerRef() }),
      ...hudTools,
    },
  })
  return null
}
