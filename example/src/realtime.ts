// The app's realtime client: new inbox messages arrive over socket.io.
import { createGate } from '@avasapp/agent-bridge'
import { socketIoTools } from '@avasapp/agent-bridge/socket.io'
import Constants from 'expo-constants'
import { io } from 'socket.io-client'

// In development, realtime-server.mjs on the same machine as Metro.
const host = Constants.expoConfig?.hostUri?.split(':')[0] ?? 'localhost'

export const socket = io(`http://${host}:8138`, { transports: ['websocket'] })

// Patch the socket here, before anything listens, so agents can see, fake
// and drop its messages. A release build gets an empty stub.
export const realtimeDevTools = socketIoTools(socket)

// Closed while a local scenario is signed in, so the socket never goes to the
// server with a fake token. Always open in a release build.
export const realtimeGate = createGate('realtime')
realtimeGate.subscribe((closed) => {
  if (closed) socket.disconnect()
  else socket.connect()
})
