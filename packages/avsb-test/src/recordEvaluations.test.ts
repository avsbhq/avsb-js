import { describe, it, expect } from 'vitest'
import { createMockClient } from './createMockClient'
import { recordEvaluations } from './recordEvaluations'

describe('recordEvaluations — basic recording', () => {
  it('records evaluations that occur after attach', () => {
    const client = createMockClient({ flags: { 'hero-cta': 'signup' } })
    const recorder = recordEvaluations(client)

    client.getStringFlag('hero-cta', 'login')

    expect(recorder.records).toHaveLength(1)
    expect(recorder.records[0].flagKey).toBe('hero-cta')
    expect(recorder.records[0].value).toBe('signup')
    recorder.stop()
  })

  it('records multiple evaluations', () => {
    const client = createMockClient({ flags: { a: 1, b: 2 } })
    const recorder = recordEvaluations(client)

    client.getNumberFlag('a', 0)
    client.getNumberFlag('b', 0)

    expect(recorder.records).toHaveLength(2)
    recorder.stop()
  })

  it('stop() clears records and detaches listener', () => {
    const client = createMockClient({ flags: { 'f': true } })
    const recorder = recordEvaluations(client)

    client.getBoolFlag('f', false)
    recorder.stop()
    // After stop, new evaluations are not captured
    client.getBoolFlag('f', false)

    expect(recorder.records).toHaveLength(0)
  })
})

describe('recordEvaluations — toHaveEvaluated', () => {
  it('passes when the flag was evaluated', () => {
    const client = createMockClient({ flags: { 'checkout-v2': true } })
    const recorder = recordEvaluations(client)

    client.getBoolFlag('checkout-v2', false)

    expect(() => recorder.toHaveEvaluated('checkout-v2')).not.toThrow()
    recorder.stop()
  })

  it('throws when the flag was NOT evaluated', () => {
    const client = createMockClient({ flags: { 'checkout-v2': true } })
    const recorder = recordEvaluations(client)

    // Do not evaluate checkout-v2
    client.getBoolFlag('other-flag', false)

    expect(() => recorder.toHaveEvaluated('checkout-v2')).toThrowError(
      /checkout-v2/
    )
    recorder.stop()
  })

  it('throws informatively listing which flags were evaluated', () => {
    const client = createMockClient({ flags: { 'a': true, 'b': false } })
    const recorder = recordEvaluations(client)

    client.getBoolFlag('a', false)

    let message = ''
    try {
      recorder.toHaveEvaluated('b')
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('a')
    recorder.stop()
  })
})

describe('recordEvaluations — withValue', () => {
  it('passes when evaluated with the expected value', () => {
    const client = createMockClient({ flags: { 'theme': 'dark' } })
    const recorder = recordEvaluations(client)

    client.getStringFlag('theme', 'light')

    expect(() => recorder.toHaveEvaluated('theme').withValue('dark')).not.toThrow()
    recorder.stop()
  })

  it('throws when evaluated with a different value', () => {
    const client = createMockClient({ flags: { 'theme': 'dark' } })
    const recorder = recordEvaluations(client)

    client.getStringFlag('theme', 'light')

    expect(() => recorder.toHaveEvaluated('theme').withValue('light')).toThrowError(
      /theme/
    )
    recorder.stop()
  })

  it('withValue works for object values via JSON equality', () => {
    const client = createMockClient({ flags: { 'cfg': { retries: 3 } } })
    const recorder = recordEvaluations(client)

    client.getJsonFlag('cfg', { retries: 0 })

    expect(() =>
      recorder.toHaveEvaluated('cfg').withValue({ retries: 3 })
    ).not.toThrow()
    recorder.stop()
  })
})

describe('recordEvaluations — withContext', () => {
  it('passes when evaluated with matching context key', () => {
    const client = createMockClient({
      flags: { 'exp': 'v2' },
      context: { kind: 'user', key: 'alice' },
    })
    const recorder = recordEvaluations(client)

    client.getStringFlag('exp', 'ctrl')

    expect(() =>
      recorder
        .toHaveEvaluated('exp')
        .withContext({ kind: 'user', key: 'alice' })
    ).not.toThrow()
    recorder.stop()
  })

  it('throws when evaluated with a different context key', () => {
    const client = createMockClient({
      flags: { 'exp': 'v2' },
      context: { kind: 'user', key: 'alice' },
    })
    const recorder = recordEvaluations(client)

    client.getStringFlag('exp', 'ctrl')

    expect(() =>
      recorder
        .toHaveEvaluated('exp')
        .withContext({ kind: 'user', key: 'bob' })
    ).toThrowError(/bob/)
    recorder.stop()
  })

  it('withContext + withValue can be chained', () => {
    const client = createMockClient({
      flags: { 'color': 'blue' },
      context: { kind: 'user', key: 'u1' },
    })
    const recorder = recordEvaluations(client)

    client.getStringFlag('color', 'red')

    expect(() =>
      recorder
        .toHaveEvaluated('color')
        .withContext({ kind: 'user', key: 'u1' })
        .withValue('blue')
    ).not.toThrow()
    recorder.stop()
  })
})

describe('recordEvaluations — toHaveTracked', () => {
  it('passes when the event was tracked', () => {
    const client = createMockClient()
    const recorder = recordEvaluations(client)

    client.track('purchase', { value: 49.99 })

    expect(() => recorder.toHaveTracked('purchase')).not.toThrow()
    recorder.stop()
  })

  it('throws when the event was NOT tracked', () => {
    const client = createMockClient()
    const recorder = recordEvaluations(client)

    expect(() => recorder.toHaveTracked('purchase')).toThrowError(/purchase/)
    recorder.stop()
  })

  it('toHaveTracked().withValue passes on correct numeric value', () => {
    const client = createMockClient()
    const recorder = recordEvaluations(client)

    client.track('add-to-cart', { value: 29.99 })

    expect(() =>
      recorder.toHaveTracked('add-to-cart').withValue(29.99)
    ).not.toThrow()
    recorder.stop()
  })

  it('toHaveTracked().withValue throws on wrong value', () => {
    const client = createMockClient()
    const recorder = recordEvaluations(client)

    client.track('add-to-cart', { value: 29.99 })

    expect(() =>
      recorder.toHaveTracked('add-to-cart').withValue(99.99)
    ).toThrowError(/99\.99/)
    recorder.stop()
  })

  it('toHaveTracked().withProperties passes on matching properties', () => {
    const client = createMockClient()
    const recorder = recordEvaluations(client)

    client.track('view', { properties: { page: 'checkout', variant: 'A' } })

    expect(() =>
      recorder.toHaveTracked('view').withProperties({ page: 'checkout', variant: 'A' })
    ).not.toThrow()
    recorder.stop()
  })
})
