import { describe, expect, it } from 'vitest'
import { Injector, runInInjectionContext } from '@angular/core'
import { createFlag } from '@avsbhq/core'
import type { Flag } from '@avsbhq/core'
import { AvsbService } from './avsb.service'
import { MockAvsbClient } from './test-support/mockClient'
import { createTestService } from './test-support/testInjector'
import { NO_CLIENT_MESSAGE } from './internal/messages'

function flagOf<T>(value: T, variationKey: string): Flag<T> {
  return createFlag<T>({
    value,
    variationKey,
    source: 'rule',
    ruleId: 'r1',
    ruleType: 'ab_test',
    reasons: ['matched rule r1'],
  })
}

const ON = flagOf(true, 'on')
const OFF = flagOf(false, 'off')

/** A ready client with the given flags, which is the common starting point. */
function readyClient(flags: Record<string, Flag<unknown>> = {}): MockAvsbClient {
  const client = new MockAvsbClient(flags)
  client.settle({ success: true, source: 'network' })
  return client
}

describe('AvsbService construction', () => {
  it('throws an actionable error when no client is configured', () => {
    // What an application that forgot provideAvsb() gets: the service is
    // providedIn root, so DI happily builds it with no client behind it.
    const bare = Injector.create({ providers: [] })

    expect(() =>
      runInInjectionContext(bare, () => new AvsbService())
    ).toThrowError(NO_CLIENT_MESSAGE)
    expect(NO_CLIENT_MESSAGE).toContain('provideAvsb')
    expect(NO_CLIENT_MESSAGE).toContain('AvsbModule.forRoot')
  })

  it('adopts a client that is already ready before any event fires', () => {
    const service = createTestService(readyClient())

    expect(service.status()).toBe('ready')
    expect(service.isReady()).toBe(true)
  })

  it('stays loading until the client settles', () => {
    const client = new MockAvsbClient()
    const service = createTestService(client)

    expect(service.status()).toBe('loading')

    client.settle({ success: true, source: 'network' })
    expect(service.status()).toBe('ready')
  })

  it('reports a failed init as error with the client message', async () => {
    const client = new MockAvsbClient()
    const service = createTestService(client)
    const failure = new Error(
      'datafile 404 for https://cdn.avsb.cloud/sdk_x/datafile.json'
    )

    client.emitError(failure)
    // The bus error alone must not be fatal: nothing has settled yet, and a
    // degraded init emits exactly this event before succeeding.
    expect(service.status()).toBe('loading')

    client.settle({ success: false, source: 'error', error: failure })
    // A failed settle emits no 'ready' event; the service learns about it
    // through onReady(), so let that continuation run.
    await client.onReady()

    expect(service.status()).toBe('error')
    expect(service.ready()).toBe(false)
    expect(service.error()).toBe(failure)
  })

  it('treats a degraded init as ready, with the reason kept as a warning', async () => {
    const client = new MockAvsbClient({ 'checkout-v2': ON })
    const service = createTestService(client)
    const stale = new Error('refresh failed, serving the cached datafile')

    client.emitError(stale)
    client.settle({ success: true, degraded: true, source: 'error', error: stale })
    await client.onReady()

    expect(service.status()).toBe('ready')
    expect(service.degraded()).toBe(true)
    expect(service.error()).toBe(stale)
  })

  it('closes the client it owns, and never one it was handed', () => {
    // Mode A: the config carried options, so this package built the client.
    const owned = readyClient()
    createTestService(owned, { sdkKey: 'sdk_test_abc' }).destroy()
    expect(owned.closeCount).toBe(1)

    // Mode B: the config carried a client, so its lifecycle is the caller's.
    const injected = readyClient()
    createTestService(injected, { client: injected }).destroy()
    expect(injected.closeCount).toBe(0)
  })

  it('releases its client listeners on destroy', () => {
    const client = readyClient()
    const service = createTestService(client)

    service.destroy()
    client.emitError(new Error('after destroy'))

    expect(service.error()).toBeNull()
  })
})

describe('AvsbService reads', () => {
  it('emits the current value synchronously on subscribe', () => {
    const service = createTestService(readyClient({ 'checkout-v2': ON }))
    const seen: Flag<boolean>[] = []

    // No await, no tick: the value must be there when subscribe returns.
    service.getFlag('checkout-v2', false).subscribe((flag) => seen.push(flag))

    expect(seen).toHaveLength(1)
    expect(seen[0].value).toBe(true)
    expect(seen[0].source).toBe('rule')
  })

  it('re-emits when the flag changes and stops after unsubscribe', () => {
    const client = readyClient({ 'checkout-v2': OFF })
    const service = createTestService(client)
    const seen: boolean[] = []

    const subscription = service
      .getFlag('checkout-v2', false)
      .subscribe((flag) => seen.push(flag.value))
    expect(seen).toEqual([false])

    client.setFlag('checkout-v2', ON)
    expect(seen).toEqual([false, true])

    subscription.unsubscribe()
    client.setFlag('checkout-v2', OFF)
    expect(seen).toEqual([false, true])
  })

  it('wakes subscribers on the ready transition, not just on later changes', () => {
    const client = new MockAvsbClient({ 'checkout-v2': ON })
    const service = createTestService(client)
    const sources: string[] = []

    service.getFlag('checkout-v2', false).subscribe((flag) => sources.push(flag.source))
    expect(sources).toEqual(['not_ready'])

    client.settle({ success: true, source: 'network' })
    expect(sources).toEqual(['not_ready', 'rule'])
  })

  it('reads through the exposure-free path, never firing an exposure', () => {
    const client = readyClient({ 'checkout-v2': ON })
    const service = createTestService(client)

    service.getFlag('checkout-v2', false).subscribe()
    service.getBoolFlag('checkout-v2', false).subscribe()
    service.getStringFlag('hero', 'control').subscribe()
    service.getNumberFlag('limit', 10).subscribe()
    service.getJsonFlag('config', { a: 1 }).subscribe()

    expect(client.exposures).toEqual([])
    for (const read of client.reads) {
      expect(read.options?.readOnly).toBe(true)
    }
  })

  it('returns the same object for repeated reads of an unchanged flag', () => {
    const service = createTestService(readyClient({ 'checkout-v2': ON }))

    const first = service.snapshot('checkout-v2', false)
    const second = service.snapshot('checkout-v2', false)

    expect(first).toBe(second)
  })

  it('maps getFlagValue to the raw value', () => {
    const service = createTestService(readyClient({ hero: flagOf('variant-a', 'a') }))
    const seen: string[] = []

    service.getFlagValue('hero', 'control').subscribe((value) => seen.push(value))

    expect(seen).toEqual(['variant-a'])
  })

  it('collapses the ready burst of flagChange events into one emission', () => {
    const client = readyClient({ a: ON, b: OFF })
    const service = createTestService(client)
    const emissions: Record<string, Flag>[] = []

    service.getAllFlags().subscribe((flags) => emissions.push(flags))
    // Two events, no value change between them: the client hands back the
    // same object, so distinctUntilChanged drops the duplicates.
    client.emit('flagChange', { flagKey: 'a', previousValue: true, newValue: true })
    client.emit('flagChange', { flagKey: 'b', previousValue: false, newValue: false })

    expect(emissions).toHaveLength(1)
    expect(Object.keys(emissions[0])).toEqual(['a', 'b'])
  })
})

describe('AvsbService exposure', () => {
  it('records one exposure immediately when the SDK is ready', () => {
    const client = readyClient({ 'checkout-v2': ON })
    const service = createTestService(client)

    service.recordExposure('checkout-v2', false)

    expect(client.exposures).toEqual(['checkout-v2'])
  })

  it('waits for the datafile, then records once', () => {
    const client = new MockAvsbClient({ 'checkout-v2': ON })
    const service = createTestService(client)

    service.recordExposure('checkout-v2', false)
    expect(client.exposures).toEqual([])

    client.settle({ success: true, source: 'network' })
    expect(client.exposures).toEqual(['checkout-v2'])
  })

  it('records nothing when the wait is cancelled first', () => {
    const client = new MockAvsbClient({ 'checkout-v2': ON })
    const service = createTestService(client)

    const cancel = service.recordExposure('checkout-v2', false)
    cancel()
    client.settle({ success: true, source: 'network' })

    expect(client.exposures).toEqual([])
  })
})

describe('AvsbService identity and events', () => {
  it('forwards identify, alias, reset, track and flush to the client', async () => {
    const client = readyClient()
    const service = createTestService(client)

    service.identify({ kind: 'user', key: 'u_1', plan: 'pro' })
    service.alias({ kind: 'user', key: 'anon_1' }, { kind: 'user', key: 'u_1' })
    service.reset()
    service.track('purchase', { value: 42 })
    await service.flush()

    expect(client.identified).toEqual([{ kind: 'user', key: 'u_1', plan: 'pro' }])
    expect(client.aliased).toHaveLength(1)
    expect(client.resetCount).toBe(1)
    expect(client.tracked).toEqual([{ eventKey: 'purchase', payload: { value: 42 } }])
    expect(client.flushCount).toBe(1)
  })
})
