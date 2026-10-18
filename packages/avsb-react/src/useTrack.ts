import { useCallback, useRef } from 'react'
import type { TrackPayload } from '@avsbhq/core'
import { useAvsbContext } from './context'

/**
 * §5.16: Returns a stable `track` function that survives the
 * loading → ready transition without changing its reference.
 *
 * The function delegates to `client.track()` via a ref so that callers
 * do not need to re-subscribe to `useTrack` when the client becomes
 * ready.
 *
 * @returns `(eventKey: string, payload?: TrackPayload) => void`
 */
export function useTrack(): (eventKey: string, payload?: TrackPayload) => void {
  const { client } = useAvsbContext()

  // Hold the latest client in a ref so the callback below never goes
  // stale after the loading → ready transition.
  const clientRef = useRef(client)
  clientRef.current = client

  return useCallback((eventKey: string, payload?: TrackPayload) => {
    const c = clientRef.current
    if (!c || typeof c.track !== 'function') return
    c.track(eventKey, payload)
  }, []) // stable reference — never changes
}
