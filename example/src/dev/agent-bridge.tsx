import { cdpTransport, useAgentBridge } from '@avasapp/agent-bridge'
import { expoTransport } from '@avasapp/agent-bridge/expo'
import { routerTools } from '@avasapp/agent-bridge/expo-router'
import { queryTools } from '@avasapp/agent-bridge/tanstack-query'
import { storeTools } from '@avasapp/agent-bridge/zustand'
import { useQueryClient } from '@tanstack/react-query'
import { router } from 'expo-router'

import { useSettings } from '@/settings'

import { hideHud, hudTools } from './hud'

export function AgentBridge() {
  const queryClient = useQueryClient()
  const query = queryTools(queryClient)
  useAgentBridge({
    name: 'sprout',
    transports: [expoTransport(), cdpTransport()],
    tools: {
      ...query,
      ...storeTools({ settings: useSettings }),
      ...routerTools(router),
      ...hudTools,
      // bridge.restore runs this along with query.restore and store.restore.
      'app.restore': {
        description: 'Hide the step overlay.',
        run: () => {
          hideHud()
          return true
        },
      },
    },
  })
  return null
}
