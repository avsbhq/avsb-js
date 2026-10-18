import type { ReactAvsbClient } from './clientInterface'
import { useAvsbContext } from './context'

/**
 * The client, suspending until it exists and its init attempt has settled.
 *
 * ```ts
 * function useAvsbClientSuspense(): ReactAvsbClient
 * ```
 *
 * Never returns null. Must be rendered inside a `<Suspense fallback={...}>`
 * boundary. For nullable access without Suspense, use `useAvsbClient()`.
 *
 * A failed init does NOT keep this suspended: the promise resolves when
 * the provider's status leaves `'loading'`, so an unreachable CDN gives
 * you the client back (every read returns your defaults) rather than a
 * fallback that never goes away. Read `useAvsbStatus()` if you need to
 * show that failure.
 *
 * In a server render the client does not exist, so this suspends and your
 * fallback is what lands in the HTML; the real value arrives after
 * hydration.
 *
 * GUARD ORDER MATTERS. Suspending must be gated on the status, never on
 * "there is no client yet": with a missing sdkKey the provider settles to
 * `'error'` with no client at all, so a client-first guard would throw an
 * already-resolved promise, React would retry, and the component would
 * spin forever on a fallback instead of showing the error below.
 */
export function useAvsbClientSuspense(): ReactAvsbClient {
  const { client, status, whenReady } = useAvsbContext()

  // Still settling: suspend. Covers the server render and the first client
  // render of Mode A, where the client is built in a layout effect.
  if (status === 'loading' && whenReady) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the Suspense protocol is "throw a promise"
    throw whenReady
  }

  // Settled with no client: a configuration problem, and loud.
  if (!client) {
    throw new Error(
      '[avsb] useAvsbClientSuspense: there is no client. <AvsbProvider> needs ' +
        'either an sdkKey (it looks like "sdk_production_xxxxxxxx", copy it from ' +
        'Environments in the project sidebar, in the A vs B dashboard) or a pre-built ' +
        'client prop.',
    )
  }

  return client
}
