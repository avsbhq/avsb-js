// CleanupRegistry — every persistent resource an SDK client creates (polling
// timers, streaming clients, async iterators, middleware-bound storage,
// registered listeners) registers a teardown function. `client.close()`
// drains them all. Ported from `snippet/src/utils/registry.ts` and adopted
// as the canonical implementation per spec §6.4.

export interface CleanupRegistry {
  /** Register a teardown fn; returns a disposer that runs it once and forgets it. */
  add(teardown: () => void): () => void
  /** Run every registered teardown (each guarded so one throw can't strand the rest). */
  drain(): void
  /** Current count of pending teardowns, useful in tests. */
  size(): number
}

export function createRegistry(): CleanupRegistry {
  let teardowns: Array<() => void> = []

  return {
    add(teardown) {
      teardowns.push(teardown)
      let done = false
      return () => {
        if (done) return
        done = true
        const idx = teardowns.indexOf(teardown)
        if (idx !== -1) teardowns.splice(idx, 1)
        try {
          teardown()
        } catch {
          /* teardown is best-effort */
        }
      }
    },
    drain() {
      const pending = teardowns
      teardowns = []
      for (const teardown of pending) {
        try {
          teardown()
        } catch {
          /* one bad teardown must not strand the others */
        }
      }
    },
    size() {
      return teardowns.length
    },
  }
}
