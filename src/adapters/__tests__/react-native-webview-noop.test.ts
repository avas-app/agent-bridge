import { describe, expect, test } from 'bun:test'

import * as noop from '../../noop/react-native-webview'
import type * as real from '../react-native-webview'

// The release entry takes exactly what the real hook takes, and its props are a
// subset of the real props: switching entries can't change what compiles.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const sameParams: Same<
  Parameters<typeof noop.useWebViewTools>,
  Parameters<typeof real.useWebViewTools>
> = true
const propsSubset: keyof ReturnType<typeof noop.useWebViewTools>['props'] extends keyof ReturnType<
  typeof real.useWebViewTools
>['props']
  ? true
  : false = true
void sameParams
void propsSubset

const ref = { current: null }

describe('release entry', () => {
  test("props carry the app's own script and handlers from options", () => {
    const onLoadStart = () => {}
    const onLoadEnd = () => {}
    const onNavigationStateChange = () => {}
    const { props } = noop.useWebViewTools(ref, {
      name: 'checkout',
      allowedOrigins: ['https://pay.example.com'],
      injectedJavaScriptBeforeContentLoaded: 'window.token = "abc";true;',
      onLoadStart,
      onLoadEnd,
      onNavigationStateChange,
    })
    // Exactly these: no adapter script and no ForMainFrameOnly, as if the adapter weren't there.
    expect(props).toEqual({
      injectedJavaScriptBeforeContentLoaded: 'window.token = "abc";true;',
      onLoadStart,
      onLoadEnd,
      onNavigationStateChange,
    })
    expect(props.onLoadEnd).toBe(onLoadEnd)
  })

  test('options that are not set are left out', () => {
    const onLoadEnd = () => {}
    const { props } = noop.useWebViewTools(ref, { name: 'checkout', onLoadEnd })
    expect(Object.keys(props)).toEqual(['onLoadEnd'])
  })

  test('props are empty when no script or handlers are given', () => {
    const { props } = noop.useWebViewTools(ref, { name: 'checkout' })
    expect(props).toEqual({})
    expect(Object.keys(props)).toEqual([])
  })

  test('wrap returns the handler unchanged', () => {
    const onMessage = () => {}
    const { wrap } = noop.useWebViewTools(ref, { name: 'checkout' })
    expect(wrap(onMessage)).toBe(onMessage)
    expect(wrap()).toBeUndefined()
  })
})
