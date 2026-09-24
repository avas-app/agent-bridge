import { cdpTransport, type ToolDefinition, useAgentBridge } from '@avasapp/agent-bridge'
import { expoTransport } from '@avasapp/agent-bridge/expo'
import { routerTools } from '@avasapp/agent-bridge/expo-router'
import { queryTools } from '@avasapp/agent-bridge/tanstack-query'
import { storeTools } from '@avasapp/agent-bridge/zustand'
import { useQueryClient } from '@tanstack/react-query'
import { router } from 'expo-router'

import { useSettings } from '@/settings'

import { hudTools } from './hud'

const run = (tool: ToolDefinition | undefined) =>
  typeof tool === 'function' ? tool() : tool?.run()

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
      'app.reset': {
        description: 'Unpin every query and restore settings.',
        run: () => {
          useSettings.setState(useSettings.getInitialState())
          return { unpinned: run(query['query.unpinAll']) }
        },
      },
    },
  })
  return null
}
