import { describe, expect, it } from 'vitest'
import { MAX_JSON_KEYS, inferJsonType, propertyName } from './jsonTypeInference.js'

describe('inferJsonType — primitives and absence', () => {
  it('returns unknown when there are no values', () => {
    expect(inferJsonType([])).toBe('unknown')
  })

  it('returns unknown when every value is not JSON', () => {
    expect(inferJsonType([undefined, undefined])).toBe('unknown')
  })

  it('widens primitives rather than pinning literals', () => {
    expect(inferJsonType(['dark', 'light'])).toBe('string')
    expect(inferJsonType([1, 2.5])).toBe('number')
    expect(inferJsonType([true, false])).toBe('boolean')
    expect(inferJsonType([null])).toBe('null')
  })

  it('unions values of different kinds, in a stable order', () => {
    expect(inferJsonType(['a', 1])).toBe('number | string')
    expect(inferJsonType([1, 'a'])).toBe('number | string')
  })
})

describe('inferJsonType — objects', () => {
  it('merges keys across variations and sorts them', () => {
    expect(inferJsonType([{ b: 1, a: 'x' }])).toBe('{ a: string; b: number }')
  })

  it('marks a key optional when a variation omits it', () => {
    expect(inferJsonType([{ a: 1 }, { a: 2, b: 'x' }])).toBe('{ a: number; b?: string }')
  })

  it('unions a key whose type differs between variations', () => {
    expect(inferJsonType([{ a: 1 }, { a: 'x' }])).toBe('{ a: number | string }')
  })

  it('quotes a key that is not a bare identifier', () => {
    expect(inferJsonType([{ 'my-key': 1 }])).toBe("{ 'my-key': number }")
  })

  it('describes an object with no keys at all', () => {
    expect(inferJsonType([{}])).toBe('Record<string, never>')
  })

  it('gives up on an object with more keys than the cap', () => {
    const wide: Record<string, number> = {}
    for (let i = 0; i <= MAX_JSON_KEYS; i += 1) wide[`k${i}`] = i
    expect(inferJsonType([wide])).toBe('unknown')
  })
})

describe('inferJsonType — arrays and nesting', () => {
  it('types an array by its element union', () => {
    expect(inferJsonType([['a', 'b']])).toBe('string[]')
  })

  it('parenthesises a union element type', () => {
    expect(inferJsonType([['a', 1]])).toBe('(number | string)[]')
  })

  it('types an empty array as unknown[] rather than guessing', () => {
    expect(inferJsonType([[]])).toBe('unknown[]')
  })

  it('recurses into nested objects', () => {
    expect(inferJsonType([{ theme: { primary: '#fff' } }])).toBe(
      '{ theme: { primary: string } }',
    )
  })

  it('gives up past the depth cap instead of emitting a half type', () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } }
    expect(inferJsonType([deep])).toBe('unknown')
  })
})

describe('propertyName', () => {
  it('leaves a bare identifier alone', () => {
    expect(propertyName('primary')).toBe('primary')
    expect(propertyName('_private$1')).toBe('_private$1')
  })

  it('quotes anything else and escapes the quote character', () => {
    expect(propertyName('my-key')).toBe("'my-key'")
    expect(propertyName("it's")).toBe("'it\\'s'")
  })
})
