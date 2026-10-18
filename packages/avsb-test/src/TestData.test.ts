import { describe, it, expect } from 'vitest'
import { TestData } from './TestData'

describe('TestData.flag — type setting', () => {
  it('booleanFlag sets type to boolean', () => {
    const entry = TestData.flag('my-flag').booleanFlag().build()
    expect(entry.type).toBe('boolean')
  })

  it('stringFlag sets type to string', () => {
    const entry = TestData.flag('my-flag').stringFlag().build()
    expect(entry.type).toBe('string')
  })

  it('numberFlag sets type to number', () => {
    const entry = TestData.flag('my-flag').numberFlag().build()
    expect(entry.type).toBe('number')
  })

  it('jsonFlag sets type to json', () => {
    const entry = TestData.flag('my-flag').jsonFlag().build()
    expect(entry.type).toBe('json')
  })

  it('default type is boolean when no type method is called', () => {
    const entry = TestData.flag('my-flag').build()
    expect(entry.type).toBe('boolean')
  })
})

describe('TestData.flag — key preservation', () => {
  it('preserves the flag key', () => {
    const entry = TestData.flag('checkout-v2').build()
    expect(entry.key).toBe('checkout-v2')
  })

  it('two flags with different keys produce different entries', () => {
    const a = TestData.flag('flag-a').build()
    const b = TestData.flag('flag-b').build()
    expect(a.key).not.toBe(b.key)
  })
})

describe('TestData.flag — variationForUser', () => {
  it('records a variation and a user override', () => {
    const entry = TestData.flag('beta')
      .booleanFlag()
      .variationForUser('u_1', true)
      .build()

    expect(entry.variations).toHaveLength(1)
    expect(entry.variations[0].value).toBe(true)
    expect(entry.overrides).toHaveLength(1)
    expect(entry.overrides[0].userId).toBe('u_1')
    expect(entry.overrides[0].variationId).toBe(entry.variations[0].id)
  })

  it('multiple variationForUser calls produce distinct variations + overrides', () => {
    const entry = TestData.flag('multi')
      .booleanFlag()
      .variationForUser('alice', 'on')
      .variationForUser('bob', 'off')
      .build()

    expect(entry.variations).toHaveLength(2)
    expect(entry.overrides).toHaveLength(2)
    expect(entry.overrides[0].userId).toBe('alice')
    expect(entry.overrides[1].userId).toBe('bob')
    // Each override references its own variation
    expect(entry.overrides[0].variationId).not.toBe(entry.overrides[1].variationId)
  })

  it('empty overrides when no variationForUser is called', () => {
    const entry = TestData.flag('plain').build()
    expect(entry.overrides).toHaveLength(0)
    expect(entry.variations).toHaveLength(0)
  })
})

describe('TestData.flag — variationForContext', () => {
  it('records a context override', () => {
    const entry = TestData.flag('org-feature')
      .booleanFlag()
      .variationForContext('organization', 'acme', true)
      .build()

    expect(entry.contextOverrides).toHaveLength(1)
    expect(entry.contextOverrides[0].kind).toBe('organization')
    expect(entry.contextOverrides[0].key).toBe('acme')
    expect(entry.variations).toHaveLength(1)
  })

  it('context overrides are independent from user overrides', () => {
    const entry = TestData.flag('combo')
      .variationForUser('alice', 'user-val')
      .variationForContext('org', 'acme', 'org-val')
      .build()

    expect(entry.overrides).toHaveLength(1)
    expect(entry.contextOverrides).toHaveLength(1)
    expect(entry.variations).toHaveLength(2)
  })
})

describe('TestData.flag — fallthroughVariation', () => {
  it('sets the fallthroughValue', () => {
    const entry = TestData.flag('checkout-v2')
      .booleanFlag()
      .fallthroughVariation(false)
      .build()

    expect(entry.fallthroughValue).toBe(false)
  })

  it('fallthroughValue is undefined when not set', () => {
    const entry = TestData.flag('plain').build()
    expect(entry.fallthroughValue).toBeUndefined()
  })

  it('chaining variationForUser + fallthroughVariation together', () => {
    const entry = TestData.flag('checkout-v2')
      .booleanFlag()
      .variationForUser('u_1', true)
      .fallthroughVariation(false)
      .build()

    expect(entry.overrides).toHaveLength(1)
    expect(entry.fallthroughValue).toBe(false)
  })
})

describe('TestData.flag — build immutability', () => {
  it('build() returns a new object on each call', () => {
    const td = TestData.flag('my-flag').booleanFlag()
    const a = td.build()
    const b = td.build()
    expect(a).not.toBe(b)
  })

  it('mutating a built entry does not affect subsequent builds', () => {
    const td = TestData.flag('my-flag').booleanFlag().variationForUser('alice', true)
    const a = td.build()
    // Mutate the returned array
    a.overrides.push({ userId: 'injected', variationId: 'x' })
    const b = td.build()
    expect(b.overrides).toHaveLength(1)
  })
})
