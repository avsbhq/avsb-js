import type { SvelteAvsbClient } from '../clientInterface'

/**
 * Record that this visitor has actually been shown a flag's decision.
 *
 * Reads in a component are exposure-free by design, so a value rendered from
 * a server-evaluated prop (or read through a flag store) never reaches your
 * results on its own. This is the other half of that contract: call it where
 * the decision is really shown, once.
 *
 * The read is a normal (non read-only) `getFlag`, which is what fires the
 * exposure. It only produces an event for decisions that belong in results
 * (A/B rules, holdouts, bandits); a plain rollout has nothing to expose.
 *
 * Returns a cancel function for the not-ready case, where the exposure is
 * deferred to the `ready` event instead of being dropped.
 */
export function fireExposureWhenReady(
  client: SvelteAvsbClient,
  flagKey: string
): () => void {
  if (client.isReady()) {
    client.getFlag<null>(flagKey, null)
    return () => {}
  }

  const off = client.on('ready', () => {
    client.getFlag<null>(flagKey, null)
    off()
  })

  return off
}
