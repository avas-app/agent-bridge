// Who is signed in. The example has no sign-in screen: in development the
// signedIn scenario (src/dev/scenarios.ts) signs in locally.
import { create } from 'zustand'

import type { User } from '@/api'

type Auth = { token: string | null; user: User | null }

export const useAuth = create<Auth>()(() => ({ token: null, user: null }))
