// Setups an agent or a flow can ask for by name: `scenario.apply`, or
// `export const scenario = 'signedIn'` in a flow. Development only.
import type { Scenarios } from '@avasapp/agent-bridge'
import { mockApi, strictNetwork } from '@avasapp/agent-bridge/network'

import { API_URL, type User } from '@/api'
import { realtimeGate } from '@/realtime'

const ADA: User = { id: 'u1', name: 'Ada Gardener', email: 'ada@sprout.example' }

export const scenarios: Scenarios = {
  signedIn: {
    description:
      'Signed in locally with a fake token. No request reaches a server: /me comes from a fixture, the fake backend answers the rest, and anything else fails with a 501 (see net.strict). The realtime socket stays disconnected.',
    // Checked before apply runs: a typo such as { usr } fails and says why.
    options: {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            email: { type: 'string', format: 'email' },
          },
        },
      },
    },
    apply: async ({ options, call, onUndo }) => {
      const user = { ...ADA, ...(options as { user?: Partial<User> } | undefined)?.user }
      // Guards first, so nothing leaves the app with the fake token. Held
      // with onUndo, they stay up until the store is back to signed out.
      onUndo(realtimeGate.close())
      onUndo(strictNetwork())
      onUndo(mockApi(API_URL, { 'GET /me': { json: user } }, { delayMs: 200 }))
      // Through the tool, so store.restore signs out again.
      await call('store.set', 'auth', { token: 'local-token', user })
      return { user }
    },
  },
}
