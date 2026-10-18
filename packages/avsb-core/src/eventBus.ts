import type { ClientEventMap, ClientEventName } from './types'

/**
 * Strongly-typed event bus shared across browser and server SDKs.
 *
 * `on()` returns the unsubscribe function, the modern idiom that
 * replaces the older `on/off` pair. Internally implementations may
 * still use a `Map<event, Set<callback>>` for amortised O(1) dispatch.
 */
export interface EventBus {
  on<E extends ClientEventName>(
    event: E,
    cb: ClientEventMap[E]
  ): () => void
  off<E extends ClientEventName>(
    event: E,
    cb: ClientEventMap[E]
  ): void
  emit<E extends ClientEventName>(
    event: E,
    ...args: Parameters<ClientEventMap[E]>
  ): void
}

export function createEventBus(
  onListenerError?: (event: ClientEventName, error: Error) => void
): EventBus {
  const listeners = new Map<ClientEventName, Set<unknown>>()

  return {
    on<E extends ClientEventName>(
      event: E,
      cb: ClientEventMap[E]
    ): () => void {
      let set = listeners.get(event)
      if (!set) {
        set = new Set<unknown>()
        listeners.set(event, set)
      }
      set.add(cb)
      return () => {
        set?.delete(cb)
      }
    },
    off<E extends ClientEventName>(
      event: E,
      cb: ClientEventMap[E]
    ): void {
      listeners.get(event)?.delete(cb)
    },
    emit<E extends ClientEventName>(
      event: E,
      ...args: Parameters<ClientEventMap[E]>
    ): void {
      const set = listeners.get(event)
      if (!set) return
      for (const cb of set) {
        try {
          ;(cb as (...a: Parameters<ClientEventMap[E]>) => void)(...args)
        } catch (e) {
          onListenerError?.(event, e instanceof Error ? e : new Error(String(e)))
        }
      }
    },
  }
}
