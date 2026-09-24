import type { Tools } from '../runtime/types'

/** The imperative `router` from expo-router. Passed in, so this adds no dependency. */
export type RouterLike = {
  navigate: (href: string) => void
  push: (href: string) => void
  replace: (href: string) => void
  back: () => void
  canGoBack: () => boolean
}

/** Navigate without taps. Pass `router` from `expo-router`. */
export function routerTools(router: RouterLike): Tools {
  return {
    'router.navigate': {
      description: 'Go to a route, reusing it if it is already in the stack.',
      run: (href: string) => {
        router.navigate(href)
        return href
      },
    },
    'router.push': {
      description: 'Push a route.',
      run: (href: string) => {
        router.push(href)
        return href
      },
    },
    'router.replace': {
      description: 'Replace the current route.',
      run: (href: string) => {
        router.replace(href)
        return href
      },
    },
    'router.back': {
      description: 'Go back if possible. Returns whether it could.',
      run: () => {
        const could = router.canGoBack()
        if (could) router.back()
        return could
      },
    },
  }
}
