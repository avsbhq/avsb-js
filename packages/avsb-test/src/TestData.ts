/**
 * Fluent builder for FlagDatafileEntry shapes used in tests.
 *
 * Usage:
 *   const entry = TestData.flag('checkout-v2')
 *     .booleanFlag()
 *     .variationForUser('u_1', true)
 *     .fallthroughVariation(false)
 *     .build()
 */

export interface TestDataEntry {
  key: string
  type: 'boolean' | 'string' | 'number' | 'json'
  variations: Array<{ id: string; key: string; value: unknown }>
  overrides: Array<{ userId: string; variationId: string }>
  contextOverrides: Array<{ kind: string; key: string; variationId: string }>
  fallthroughValue: unknown
}

let _variationCounter = 0

function nextVariationId(): string {
  _variationCounter += 1
  return `var-${_variationCounter}`
}

export class TestData {
  private readonly _key: string
  private _type: 'boolean' | 'string' | 'number' | 'json' = 'boolean'
  private _variations: Array<{ id: string; key: string; value: unknown }> = []
  private _overrides: Array<{ userId: string; variationId: string }> = []
  private _contextOverrides: Array<{ kind: string; key: string; variationId: string }> = []
  private _fallthroughValue: unknown = undefined

  private constructor(key: string) {
    this._key = key
  }

  /** Start building a flag entry with the given key. */
  static flag(key: string): TestData {
    return new TestData(key)
  }

  booleanFlag(): TestData {
    this._type = 'boolean'
    return this
  }

  stringFlag(): TestData {
    this._type = 'string'
    return this
  }

  numberFlag(): TestData {
    this._type = 'number'
    return this
  }

  jsonFlag(): TestData {
    this._type = 'json'
    return this
  }

  /**
   * Serve `value` to the user identified by `userKey`.
   * Creates a variation entry and an override referencing it.
   */
  variationForUser(userKey: string, value: unknown): TestData {
    const id = nextVariationId()
    this._variations.push({ id, key: `var-key-${id}`, value })
    this._overrides.push({ userId: userKey, variationId: id })
    return this
  }

  /**
   * Serve `value` to any context of `kind` with `key`.
   * Creates a variation entry and a context-level override.
   */
  variationForContext(kind: string, key: string, value: unknown): TestData {
    const id = nextVariationId()
    this._variations.push({ id, key: `var-key-${id}`, value })
    this._contextOverrides.push({ kind, key, variationId: id })
    return this
  }

  /**
   * Set the fallthrough variation value (served when no override matches).
   */
  fallthroughVariation(value: unknown): TestData {
    this._fallthroughValue = value
    return this
  }

  build(): TestDataEntry {
    return {
      key: this._key,
      type: this._type,
      variations: [...this._variations],
      overrides: [...this._overrides],
      contextOverrides: [...this._contextOverrides],
      fallthroughValue: this._fallthroughValue,
    }
  }
}
