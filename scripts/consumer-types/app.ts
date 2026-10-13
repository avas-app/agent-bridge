// Consumes the built package the way an Expo app does: its types through
// `exports`, and the app's own imports resolving each library's ESM types.
import * as Ably from 'ably'
import { QueryClient } from '@tanstack/query-core'
import { io } from 'socket.io-client'
import { createStore } from 'zustand/vanilla'

import { ablyTools } from '@avasapp/agent-bridge/ably'
import { socketIoTools } from '@avasapp/agent-bridge/socket.io'
import { queryTools } from '@avasapp/agent-bridge/tanstack-query'
import { storeTools } from '@avasapp/agent-bridge/zustand'

queryTools(new QueryClient())
ablyTools(new Ably.Realtime({ key: 'app.key:secret', autoConnect: false }))
socketIoTools(io('http://localhost:1', { autoConnect: false }))
storeTools({ settings: createStore(() => ({ theme: 'dark' })) })

// @ts-expect-error not a QueryClient
queryTools({})
