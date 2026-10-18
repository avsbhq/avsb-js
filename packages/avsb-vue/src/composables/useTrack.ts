import type { TrackPayload } from '@avsbhq/core'
import { useAvsbContext } from '../context'

/**
 * Send a conversion or metric event.
 *
 *   const track = useTrack()
 *   track('checkout_started', { value: 99, properties: { step: 'cart' } })
 *
 * Events tracked before the SDK is ready are held (bounded) and flushed as
 * soon as it is. The returned function is created once per component, so it
 * is safe to use directly as an event handler.
 */
export function useTrack(): (
  eventKey: string,
  payload?: TrackPayload
) => void {
  const { client } = useAvsbContext()
  return (eventKey: string, payload?: TrackPayload): void => {
    client.track(eventKey, payload)
  }
}
