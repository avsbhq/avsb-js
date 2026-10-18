import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEventBus, noopLogger, createFlag, notFoundFlag } from '@avsbhq/core'
import type { ClientEventMap, Flag } from '@avsbhq/core'
import { createRegistry } from './registry'
import { createChanges } from './changes'

function buildClient(initialFlags: Record<string, Flag> = {}) {
  const bus = createEventBus()
  const flags = new Map<string, Flag>(Object.entries(initialFlags))
  const client = {
    on: bus.on,
    getFlag<T = unknown>(key: string, _defaultValue: T): Flag<T> {
      const f = flags.get(key)
      return (f ?? notFoundFlag(_defaultValue, 'not_found')) as Flag<T>
    },
    _setFlag(key: string, value: Flag): void {
      const prev = flags.get(key)?.value
      flags.set(key, value)
      bus.emit('flagChange', {
        flagKey: key,
        previousValue: prev,
        newValue: value.value,
      })
    },
  }
  return client
}

describe('createChanges.onFlagChange', () => {
  it('fires the callback only for the named flag', () => {
    const client = buildClient()
    const reg = createRegistry()
    const ch = createChanges(client, reg, noopLogger)
    const cb = vi.fn()
    ch.onFlagChange('flagA', cb)
    client._setFlag(
      'flagA',
      createFlag({ value: true, variationKey: 'on', source: 'rule', ruleId: 'r1', ruleType: 'ab_test', reasons: [] })
    )
    client._setFlag(
      'flagB',
      createFlag({ value: false, variationKey: 'off', source: 'rule', ruleId: 'r1', ruleType: 'ab_test', reasons: [] })
    )
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('returned disposer unsubscribes', () => {
    const client = buildClient()
    const reg = createRegistry()
    const ch = createChanges(client, reg, noopLogger)
    const cb = vi.fn()
    const dispose = ch.onFlagChange('flagA', cb)
    dispose()
    client._setFlag(
      'flagA',
      createFlag({ value: 1, variationKey: 'a', source: 'rule', ruleId: 'r1', ruleType: 'ab_test', reasons: [] })
    )
    expect(cb).not.toHaveBeenCalled()
  })

  it('registry.drain() unsubscribes too', () => {
    const client = buildClient()
    const reg = createRegistry()
    const ch = createChanges(client, reg, noopLogger)
    const cb = vi.fn()
    ch.onFlagChange('flagA', cb)
    reg.drain()
    client._setFlag(
      'flagA',
      createFlag({ value: 1, variationKey: 'a', source: 'rule', ruleId: 'r1', ruleType: 'ab_test', reasons: [] })
    )
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('createChanges.changes()', () => {
  it('yields flagChange events in order', async () => {
    const client = buildClient()
    const reg = createRegistry()
    const ch = createChanges(client, reg, noopLogger)
    const iter = ch.changes()
    const collected: string[] = []
    const consumer = (async () => {
      let i = 0
      for await (const ev of iter) {
        collected.push(ev.flagKey)
        i++
        if (i === 2) break
      }
    })()
    client._setFlag(
      'one',
      createFlag({ value: 1, variationKey: 'a', source: 'rule', ruleId: 'r1', ruleType: 'ab_test', reasons: [] })
    )
    client._setFlag(
      'two',
      createFlag({ value: 2, variationKey: 'a', source: 'rule', ruleId: 'r1', ruleType: 'ab_test', reasons: [] })
    )
    await consumer
    expect(collected).toEqual(['one', 'two'])
  })
})

describe('createChanges.waitForFlag()', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('resolves immediately if the flag already exists', async () => {
    const client = buildClient({
      flagA: createFlag({ value: true, variationKey: 'on', source: 'rule', ruleId: 'r1', ruleType: 'ab_test', reasons: [] }),
    })
    const reg = createRegistry()
    const ch = createChanges(client, reg, noopLogger)
    const promise = Promise.resolve(ch.waitForFlag('flagA'))
    await vi.advanceTimersByTimeAsync(1)
    const flag = await promise
    expect(flag.value).toBe(true)
  })

  it('resolves when the predicate becomes true', async () => {
    const client = buildClient()
    const reg = createRegistry()
    const ch = createChanges(client, reg, noopLogger)
    const guard = ch.waitForFlag<boolean>('flagA', (f) => f.value === true)
    setTimeout(() => {
      client._setFlag(
        'flagA',
        createFlag({ value: false, variationKey: 'off', source: 'rule', ruleId: 'r1', ruleType: 'ab_test', reasons: [] })
      )
      client._setFlag(
        'flagA',
        createFlag({ value: true, variationKey: 'on', source: 'rule', ruleId: 'r1', ruleType: 'ab_test', reasons: [] })
      )
    }, 10)
    const p = Promise.resolve(guard)
    await vi.advanceTimersByTimeAsync(100)
    const f = await p
    expect(f.value).toBe(true)
  })

  it('rejects after the timeout', async () => {
    const client = buildClient()
    const reg = createRegistry()
    const ch = createChanges(client, reg, noopLogger)
    const guard = ch.waitForFlag('flagA', undefined, { timeout: 100 })
    const caught = vi.fn()
    guard.catch(caught)
    await vi.advanceTimersByTimeAsync(200)
    await Promise.resolve()
    expect(caught).toHaveBeenCalled()
  })
})
