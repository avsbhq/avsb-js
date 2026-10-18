/**
 * Provider ownership and wiring.
 *
 * Mounted with Vue's own `createApp` (no testing library) and asserted on the
 * injected context, never on markup: what matters is which client the tree
 * gets and who closes it.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { AvsbProvider } from './AvsbProvider'
import { useAvsbContext, type AvsbContextValue } from './context'
import { resolveClient } from './internal/resolveClient'
import { createTestClient, createTestDatafile } from './testing'
import type { AvsbProviderProps } from './types'

/**
 * Every client built here, so teardown can drain them all. Mode A's client is
 * created inside the provider and closed by it; the rest are Mode B clients
 * the provider deliberately leaves open, and an open client keeps a flush
 * timer armed for the whole file.
 */
const clients = new Set<{ close: () => Promise<void> }>()

function track<T extends { close: () => Promise<void> }>(client: T): T {
  clients.add(client)
  return client
}

beforeEach(() => {
  // Mode A's `unmount()` closes the client it owns, which drains the tracker
  // on the beacon-preferred teardown path. happy-dom's `navigator.sendBeacon`
  // calls `window.fetch(url, ...)` and throws the promise away, so the
  // fixture's `.invalid` collect endpoint produced a rejection nobody could
  // catch, landing after the test had already passed. Stub both transports so
  // no request leaves the process: sendBeacon reports the batch as queued and
  // creates no promise, and fetch answers everything else in-process.
  vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true)
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true } as Response)))
})

afterEach(async () => {
  // Drain while the stubs are still up, so a queued exposure cannot reach the
  // real transport on its way out. `close()` is idempotent, so the Mode A
  // client the provider already closed is a no-op here.
  for (const client of clients) await client.close()
  clients.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mountProvider(props: Record<string, unknown>): {
  context: AvsbContextValue
  unmount: () => void
} {
  let captured: AvsbContextValue | undefined

  const Child = defineComponent({
    setup() {
      captured = useAvsbContext()
      return () => null
    },
  })

  const app = createApp({
    render: () => h(AvsbProvider, props, { default: () => h(Child) }),
  })
  app.mount(document.createElement('div'))

  if (!captured) throw new Error('provider did not provide a context')
  track(captured.client)
  return { context: captured, unmount: () => app.unmount() }
}

describe('AvsbProvider', () => {
  it('Mode B adopts the client it is given and never closes it', async () => {
    const client = createTestClient({ flags: { 'checkout-v2': true } })
    const close = vi.spyOn(client, 'close')

    const { context, unmount } = mountProvider({ client })

    expect(context.client).toBe(client)
    expect(context.status).toBe('ready')

    unmount()
    await nextTick()
    expect(close).not.toHaveBeenCalled()
  })

  it('Mode A builds a client from sdk-key and closes it on unmount', async () => {
    const { context, unmount } = mountProvider({
      sdkKey: 'sdk_test_0000000000000000000',
      bootstrap: createTestDatafile({ 'checkout-v2': true }),
      options: { autoRefresh: false, cache: false, logLevel: 'silent' },
    })

    const close = vi.spyOn(context.client, 'close')
    expect(context.client.getBoolFlag('checkout-v2', false).value).toBe(true)

    unmount()
    await nextTick()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('is ready on the first pass when a bootstrap datafile is supplied', () => {
    const { context, unmount } = mountProvider({
      client: createTestClient({ flags: { 'promo-banner': 'blue' } }),
    })

    // No await: a bootstrapped client must not flash a loading state.
    expect(context.status).toBe('ready')
    expect(context.degraded).toBe(false)
    expect(context.error).toBeUndefined()
    unmount()
  })

  it('exposes the context to composables under it', () => {
    const client = createTestClient({ flags: { 'max-items': 25 } })
    const { context, unmount } = mountProvider({ client })

    expect(context.client.getNumberFlag('max-items', 0).value).toBe(25)
    unmount()
  })
})

describe('resolveClient', () => {
  it('throws an actionable, Vue-shaped message when neither prop is given', () => {
    expect(() => resolveClient({} as AvsbProviderProps)).toThrow(
      /needs either an sdk-key \(Mode A\) or a client \(Mode B\)/
    )
    expect(() => resolveClient({} as AvsbProviderProps)).toThrow(
      /<AvsbProvider sdk-key="sdk_production_/
    )
  })

  it('treats an explicitly null client as missing rather than providing null', () => {
    expect(() =>
      resolveClient({ client: null } as unknown as AvsbProviderProps)
    ).toThrow(/Mode A/)
  })

  it('marks an injected client as not owned', () => {
    const client = track(createTestClient())
    expect(resolveClient({ client } as AvsbProviderProps)).toEqual({
      client,
      owned: false,
    })
  })
})
