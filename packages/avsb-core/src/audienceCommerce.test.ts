import { describe, it, expect } from 'vitest'
import { evaluateAudience, evaluateCondition } from './audience'
import { evaluateFlag } from './evaluate'
import type {
  Condition,
  EvalContext,
  SingleContext,
  FlagDatafile,
  FlagDatafileEntry,
  LegacyEvalContext,
  PurchaseHistoryAttribute,
} from './types'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeContext(attributes: Record<string, unknown> = {}): EvalContext {
  const ctx: SingleContext = { kind: 'user', key: 'u_1' }
  for (const [k, v] of Object.entries(attributes)) ctx[k] = v
  return ctx
}

function cartCondition(overrides: Partial<Condition> = {}): Condition {
  return {
    id: 'c-cart',
    type: 'CART_VALUE',
    operator: 'gte',
    value: '10000',
    ...overrides,
  }
}

function viewedCondition(
  overrides: Partial<Condition> & Record<string, unknown> = {}
): Condition {
  return {
    id: 'c-viewed',
    type: 'PRODUCTS_VIEWED',
    operator: 'viewed_any',
    value: ['SKU-1', 'SKU-2'],
    ...overrides,
  }
}

function purchaseCondition(overrides: Partial<Condition> = {}): Condition {
  return {
    id: 'c-purchase',
    type: 'PURCHASE_HISTORY',
    operator: 'has_purchased',
    value: '',
    ...overrides,
  }
}

function purchaseHistory(
  overrides: Partial<PurchaseHistoryAttribute> = {}
): PurchaseHistoryAttribute {
  return { hasPurchased: true, ...overrides }
}

// ---------------------------------------------------------------------------
// Unknown condition types — compatibility pin
// ---------------------------------------------------------------------------

describe('evaluateCondition — unknown condition types stay fail-closed', () => {
  it('pins the existing default: an unrecognised type evaluates false', () => {
    // This is the compatibility contract verified for Phase 7 (C10):
    // core's evaluator fails CLOSED (false) on unknown condition types —
    // unlike the snippet, which fails open. Do not change without a
    // datafile version bump.
    const condition = cartCondition({ type: 'SOME_FUTURE_TYPE' })
    expect(
      evaluateCondition(condition, makeContext({ cartValue: 100 }))
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// CART_VALUE
// ---------------------------------------------------------------------------

describe('evaluateCondition — CART_VALUE', () => {
  describe('operators (default exponent 2: "10000" minor = 100.00 major)', () => {
    it('greater_than matches above the threshold and not at it', () => {
      const c = cartCondition({ operator: 'greater_than' })
      expect(evaluateCondition(c, makeContext({ cartValue: 100.01 }))).toBe(true)
      expect(evaluateCondition(c, makeContext({ cartValue: 100 }))).toBe(false)
    })

    it('gte matches at and above the threshold', () => {
      const c = cartCondition({ operator: 'gte' })
      expect(evaluateCondition(c, makeContext({ cartValue: 100 }))).toBe(true)
      expect(evaluateCondition(c, makeContext({ cartValue: 99.99 }))).toBe(false)
    })

    it('less_than matches below the threshold and not at it', () => {
      const c = cartCondition({ operator: 'less_than' })
      expect(evaluateCondition(c, makeContext({ cartValue: 99.99 }))).toBe(true)
      expect(evaluateCondition(c, makeContext({ cartValue: 100 }))).toBe(false)
    })

    it('lte matches at and below the threshold', () => {
      const c = cartCondition({ operator: 'lte' })
      expect(evaluateCondition(c, makeContext({ cartValue: 100 }))).toBe(true)
      expect(evaluateCondition(c, makeContext({ cartValue: 100.01 }))).toBe(false)
    })

    it('between is inclusive on both ends', () => {
      const c = cartCondition({ operator: 'between', value: ['5000', '10000'] })
      expect(evaluateCondition(c, makeContext({ cartValue: 50 }))).toBe(true)
      expect(evaluateCondition(c, makeContext({ cartValue: 75 }))).toBe(true)
      expect(evaluateCondition(c, makeContext({ cartValue: 100 }))).toBe(true)
      expect(evaluateCondition(c, makeContext({ cartValue: 49.99 }))).toBe(false)
      expect(evaluateCondition(c, makeContext({ cartValue: 100.01 }))).toBe(false)
    })

    it('returns false for an operator outside the CART_VALUE vocabulary', () => {
      const c = cartCondition({ operator: 'equals' })
      expect(evaluateCondition(c, makeContext({ cartValue: 100 }))).toBe(false)
    })
  })

  describe('currency exponent conversion', () => {
    it('uses exponent 0 when provided (JPY-style: "10000" minor = 10000 major)', () => {
      const c = cartCondition({ operator: 'gte' })
      const opts = { currencyExponent: 0 }
      expect(evaluateCondition(c, makeContext({ cartValue: 10000 }), opts)).toBe(true)
      expect(evaluateCondition(c, makeContext({ cartValue: 9999 }), opts)).toBe(false)
    })

    it('uses exponent 3 when provided (BHD-style: "10000" minor = 10 major)', () => {
      const c = cartCondition({ operator: 'gte' })
      const opts = { currencyExponent: 3 }
      expect(evaluateCondition(c, makeContext({ cartValue: 10 }), opts)).toBe(true)
      expect(evaluateCondition(c, makeContext({ cartValue: 9.999 }), opts)).toBe(false)
    })

    it('defaults to exponent 2 when options are omitted or empty', () => {
      const c = cartCondition({ operator: 'gte' })
      expect(evaluateCondition(c, makeContext({ cartValue: 100 }))).toBe(true)
      expect(evaluateCondition(c, makeContext({ cartValue: 100 }), {})).toBe(true)
    })
  })

  describe('missing / mistyped inputs fail closed', () => {
    const operators = ['greater_than', 'gte', 'less_than', 'lte'] as const

    it.each(operators)('%s returns false when cartValue is absent', (operator) => {
      expect(
        evaluateCondition(cartCondition({ operator }), makeContext({}))
      ).toBe(false)
    })

    it.each(operators)('%s returns false when cartValue is a string', (operator) => {
      expect(
        evaluateCondition(
          cartCondition({ operator }),
          makeContext({ cartValue: '100' })
        )
      ).toBe(false)
    })

    it('between returns false when cartValue is absent', () => {
      const c = cartCondition({ operator: 'between', value: ['5000', '10000'] })
      expect(evaluateCondition(c, makeContext({}))).toBe(false)
    })

    it('returns false when cartValue is NaN or null', () => {
      const c = cartCondition({ operator: 'gte' })
      expect(evaluateCondition(c, makeContext({ cartValue: NaN }))).toBe(false)
      expect(evaluateCondition(c, makeContext({ cartValue: null }))).toBe(false)
    })

    it('returns false for a non-numeric condition value', () => {
      const c = cartCondition({ operator: 'gte', value: 'abc' })
      expect(evaluateCondition(c, makeContext({ cartValue: 100 }))).toBe(false)
    })

    it('returns false for an empty condition value', () => {
      const c = cartCondition({ operator: 'gte', value: '' })
      expect(evaluateCondition(c, makeContext({ cartValue: 100 }))).toBe(false)
    })

    it('between returns false when value is not a two-element array', () => {
      const single = cartCondition({ operator: 'between', value: '5000' })
      const short = cartCondition({ operator: 'between', value: ['5000'] })
      const badBound = cartCondition({ operator: 'between', value: ['5000', 'x'] })
      expect(evaluateCondition(single, makeContext({ cartValue: 75 }))).toBe(false)
      expect(evaluateCondition(short, makeContext({ cartValue: 75 }))).toBe(false)
      expect(evaluateCondition(badBound, makeContext({ cartValue: 75 }))).toBe(false)
    })
  })

  describe('context shapes', () => {
    it('resolves cartValue from a legacy attribute-bag context', () => {
      const legacy: LegacyEvalContext = { attributes: { cartValue: 150 } }
      expect(evaluateCondition(cartCondition(), legacy)).toBe(true)
    })

    it('resolves cartValue from a declared contextKind in a multi-context', () => {
      const multi: EvalContext = {
        kind: 'multi',
        user: { kind: 'user', key: 'u_1', cartValue: 150 },
      }
      const c = cartCondition({ contextKind: 'user' })
      expect(evaluateCondition(c, multi)).toBe(true)
    })

    it('returns false when the declared contextKind is missing', () => {
      const c = cartCondition({ contextKind: 'organization' })
      expect(evaluateCondition(c, makeContext({ cartValue: 150 }))).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// PRODUCTS_VIEWED
// ---------------------------------------------------------------------------

describe('evaluateCondition — PRODUCTS_VIEWED', () => {
  it('viewed_any matches when any condition sku is in viewedSkus', () => {
    const ctx = makeContext({ viewedSkus: ['SKU-2', 'SKU-9'] })
    expect(evaluateCondition(viewedCondition(), ctx)).toBe(true)
  })

  it('viewed_any does not match when no condition sku was viewed', () => {
    const ctx = makeContext({ viewedSkus: ['SKU-9'] })
    expect(evaluateCondition(viewedCondition(), ctx)).toBe(false)
  })

  it('not_viewed_any is the negation when the attribute is present', () => {
    const c = viewedCondition({ operator: 'not_viewed_any' })
    expect(
      evaluateCondition(c, makeContext({ viewedSkus: ['SKU-9'] }))
    ).toBe(true)
    expect(
      evaluateCondition(c, makeContext({ viewedSkus: ['SKU-1'] }))
    ).toBe(false)
  })

  it('not_viewed_any is true for a present-but-empty viewedSkus array', () => {
    const c = viewedCondition({ operator: 'not_viewed_any' })
    expect(evaluateCondition(c, makeContext({ viewedSkus: [] }))).toBe(true)
  })

  it('match=category consults viewedCategories instead of viewedSkus', () => {
    const c = viewedCondition({ match: 'category', value: ['trainers'] })
    expect(
      evaluateCondition(c, makeContext({ viewedCategories: ['trainers'] }))
    ).toBe(true)
    expect(
      evaluateCondition(c, makeContext({ viewedSkus: ['trainers'] }))
    ).toBe(false)
  })

  it('omitted match defaults to sku', () => {
    const ctx = makeContext({ viewedSkus: ['SKU-1'] })
    expect(evaluateCondition(viewedCondition(), ctx)).toBe(true)
  })

  it('datasetSlug conditions evaluate false for BOTH operators (server-side limitation)', () => {
    const ctx = makeContext({ viewedSkus: ['SKU-1'] })
    const positive = viewedCondition({ datasetSlug: 'vip-products', value: [] })
    const negative = viewedCondition({
      datasetSlug: 'vip-products',
      operator: 'not_viewed_any',
      value: [],
    })
    expect(evaluateCondition(positive, ctx)).toBe(false)
    expect(evaluateCondition(negative, ctx)).toBe(false)
  })

  it('datasetSlug wins even when a literal value list would match', () => {
    const c = viewedCondition({ datasetSlug: 'vip-products' })
    expect(
      evaluateCondition(c, makeContext({ viewedSkus: ['SKU-1'] }))
    ).toBe(false)
  })

  it('missing attribute array fails closed for both operators', () => {
    expect(evaluateCondition(viewedCondition(), makeContext({}))).toBe(false)
    expect(
      evaluateCondition(
        viewedCondition({ operator: 'not_viewed_any' }),
        makeContext({})
      )
    ).toBe(false)
  })

  it('mistyped attribute (string instead of array) fails closed', () => {
    const ctx = makeContext({ viewedSkus: 'SKU-1' })
    expect(evaluateCondition(viewedCondition(), ctx)).toBe(false)
  })

  it('ignores non-string entries in the attribute array', () => {
    const ctx = makeContext({ viewedSkus: [42, null, 'SKU-1'] })
    expect(evaluateCondition(viewedCondition(), ctx)).toBe(true)
  })

  it('empty condition value list evaluates false for both operators', () => {
    const ctx = makeContext({ viewedSkus: ['SKU-1'] })
    expect(evaluateCondition(viewedCondition({ value: [] }), ctx)).toBe(false)
    expect(
      evaluateCondition(
        viewedCondition({ operator: 'not_viewed_any', value: [] }),
        ctx
      )
    ).toBe(false)
  })

  it('accepts a plain string condition value as a single-item list', () => {
    const c = viewedCondition({ value: 'SKU-1' })
    expect(
      evaluateCondition(c, makeContext({ viewedSkus: ['SKU-1'] }))
    ).toBe(true)
  })

  it('returns false for an operator outside the PRODUCTS_VIEWED vocabulary', () => {
    const c = viewedCondition({ operator: 'equals' })
    expect(
      evaluateCondition(c, makeContext({ viewedSkus: ['SKU-1'] }))
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// PURCHASE_HISTORY
// ---------------------------------------------------------------------------

describe('evaluateCondition — PURCHASE_HISTORY', () => {
  const allOperators = [
    'has_purchased',
    'has_not_purchased',
    'last_purchase_older_than',
    'lifetime_spend_gt',
    'order_count_gt',
  ] as const

  it.each(allOperators)(
    '%s is false when purchaseHistory is completely absent (frozen C10 rule)',
    (operator) => {
      // Deliberate divergence from the snippet: server-side absence means
      // "not provided", not "never purchased" — so even has_not_purchased
      // fails closed.
      const c = purchaseCondition({ operator, value: '90' })
      expect(evaluateCondition(c, makeContext({}))).toBe(false)
    }
  )

  it.each(allOperators)(
    '%s is false when purchaseHistory is mistyped (string)',
    (operator) => {
      const c = purchaseCondition({ operator, value: '90' })
      const ctx = makeContext({ purchaseHistory: 'yes' })
      expect(evaluateCondition(c, ctx)).toBe(false)
    }
  )

  it('fails closed when purchaseHistory is an array or lacks a boolean hasPurchased', () => {
    const c = purchaseCondition({ operator: 'has_purchased' })
    expect(
      evaluateCondition(c, makeContext({ purchaseHistory: [] }))
    ).toBe(false)
    expect(
      evaluateCondition(c, makeContext({ purchaseHistory: {} }))
    ).toBe(false)
    expect(
      evaluateCondition(
        c,
        makeContext({ purchaseHistory: { hasPurchased: 'true' } })
      )
    ).toBe(false)
  })

  it('has_purchased reflects hasPurchased', () => {
    const c = purchaseCondition({ operator: 'has_purchased' })
    expect(
      evaluateCondition(c, makeContext({ purchaseHistory: purchaseHistory() }))
    ).toBe(true)
    expect(
      evaluateCondition(
        c,
        makeContext({ purchaseHistory: purchaseHistory({ hasPurchased: false }) })
      )
    ).toBe(false)
  })

  it('has_not_purchased is true for a present profile with hasPurchased false', () => {
    const c = purchaseCondition({ operator: 'has_not_purchased' })
    expect(
      evaluateCondition(
        c,
        makeContext({ purchaseHistory: purchaseHistory({ hasPurchased: false }) })
      )
    ).toBe(true)
    expect(
      evaluateCondition(c, makeContext({ purchaseHistory: purchaseHistory() }))
    ).toBe(false)
  })

  describe('last_purchase_older_than', () => {
    const DAY = 86_400_000

    it('is true when the last purchase is older than the given days', () => {
      const c = purchaseCondition({
        operator: 'last_purchase_older_than',
        value: '90',
      })
      const ctx = makeContext({
        purchaseHistory: purchaseHistory({
          lastPurchaseAt: Date.now() - 100 * DAY,
        }),
      })
      expect(evaluateCondition(c, ctx)).toBe(true)
    })

    it('is false when the last purchase is more recent than the given days', () => {
      const c = purchaseCondition({
        operator: 'last_purchase_older_than',
        value: '90',
      })
      const ctx = makeContext({
        purchaseHistory: purchaseHistory({
          lastPurchaseAt: Date.now() - 10 * DAY,
        }),
      })
      expect(evaluateCondition(c, ctx)).toBe(false)
    })

    it('is vacuously true when the visitor never purchased and no timestamp exists', () => {
      const c = purchaseCondition({
        operator: 'last_purchase_older_than',
        value: '90',
      })
      const ctx = makeContext({
        purchaseHistory: purchaseHistory({ hasPurchased: false }),
      })
      expect(evaluateCondition(c, ctx)).toBe(true)
    })

    it('is false when a purchaser has no usable timestamp', () => {
      const c = purchaseCondition({
        operator: 'last_purchase_older_than',
        value: '90',
      })
      expect(
        evaluateCondition(
          c,
          makeContext({ purchaseHistory: purchaseHistory() })
        )
      ).toBe(false)
      expect(
        evaluateCondition(
          c,
          makeContext({
            purchaseHistory: { hasPurchased: true, lastPurchaseAt: 'old' },
          })
        )
      ).toBe(false)
    })

    it('is false for a non-numeric days value', () => {
      const c = purchaseCondition({
        operator: 'last_purchase_older_than',
        value: 'ninety',
      })
      const ctx = makeContext({
        purchaseHistory: purchaseHistory({ lastPurchaseAt: 0 }),
      })
      expect(evaluateCondition(c, ctx)).toBe(false)
    })
  })

  describe('lifetime_spend_gt', () => {
    it('compares strictly greater after minor→major conversion (default exponent 2)', () => {
      const c = purchaseCondition({
        operator: 'lifetime_spend_gt',
        value: '10000',
      })
      const at = (lifetimeSpend: number): EvalContext =>
        makeContext({ purchaseHistory: purchaseHistory({ lifetimeSpend }) })
      expect(evaluateCondition(c, at(150))).toBe(true)
      expect(evaluateCondition(c, at(100))).toBe(false)
      expect(evaluateCondition(c, at(99))).toBe(false)
    })

    it('applies a provided exponent of 0', () => {
      const c = purchaseCondition({
        operator: 'lifetime_spend_gt',
        value: '10000',
      })
      const ctx = makeContext({
        purchaseHistory: purchaseHistory({ lifetimeSpend: 10001 }),
      })
      expect(evaluateCondition(c, ctx, { currencyExponent: 0 })).toBe(true)
      expect(evaluateCondition(c, ctx)).toBe(true)
      const low = makeContext({
        purchaseHistory: purchaseHistory({ lifetimeSpend: 9999 }),
      })
      expect(evaluateCondition(c, low, { currencyExponent: 0 })).toBe(false)
    })

    it('is false when lifetimeSpend is absent or mistyped', () => {
      const c = purchaseCondition({ operator: 'lifetime_spend_gt', value: '0' })
      expect(
        evaluateCondition(
          c,
          makeContext({ purchaseHistory: purchaseHistory() })
        )
      ).toBe(false)
      expect(
        evaluateCondition(
          c,
          makeContext({
            purchaseHistory: { hasPurchased: true, lifetimeSpend: '100' },
          })
        )
      ).toBe(false)
    })
  })

  describe('order_count_gt', () => {
    it('compares strictly greater on orderCount', () => {
      const c = purchaseCondition({ operator: 'order_count_gt', value: '5' })
      const at = (orderCount: number): EvalContext =>
        makeContext({ purchaseHistory: purchaseHistory({ orderCount }) })
      expect(evaluateCondition(c, at(6))).toBe(true)
      expect(evaluateCondition(c, at(5))).toBe(false)
    })

    it('is false when orderCount is absent, mistyped, or the value is non-numeric', () => {
      const valid = makeContext({
        purchaseHistory: purchaseHistory({ orderCount: 10 }),
      })
      expect(
        evaluateCondition(
          purchaseCondition({ operator: 'order_count_gt', value: '5' }),
          makeContext({ purchaseHistory: purchaseHistory() })
        )
      ).toBe(false)
      expect(
        evaluateCondition(
          purchaseCondition({ operator: 'order_count_gt', value: '5' }),
          makeContext({
            purchaseHistory: { hasPurchased: true, orderCount: 'ten' },
          })
        )
      ).toBe(false)
      expect(
        evaluateCondition(
          purchaseCondition({ operator: 'order_count_gt', value: 'five' }),
          valid
        )
      ).toBe(false)
    })
  })

  it('returns false for an operator outside the PURCHASE_HISTORY vocabulary', () => {
    const c = purchaseCondition({ operator: 'equals' })
    expect(
      evaluateCondition(c, makeContext({ purchaseHistory: purchaseHistory() }))
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Exponent threading — evaluateAudience options and the datafile field
// ---------------------------------------------------------------------------

describe('currencyExponent threading', () => {
  it('evaluateAudience forwards options into nested condition groups', () => {
    const audience = {
      id: 'aud-commerce',
      rules: {
        id: 'g-1',
        logic: 'AND' as const,
        conditions: [
          {
            id: 'g-2',
            logic: 'OR' as const,
            conditions: [cartCondition({ operator: 'gte', value: '5000' })],
          },
        ],
      },
    }
    // Exponent 0: threshold is 5000 major — 60 must NOT match.
    expect(
      evaluateAudience(audience, makeContext({ cartValue: 60 }), {
        currencyExponent: 0,
      })
    ).toBe(false)
    // Default exponent 2: threshold is 50 major — 60 matches.
    expect(evaluateAudience(audience, makeContext({ cartValue: 60 }))).toBe(true)
  })

  it('evaluateFlag reads currencyExponent from the FF datafile', () => {
    const flag: FlagDatafileEntry = {
      id: 'flag-1',
      key: 'big-cart-banner',
      type: 'boolean',
      enabled: true,
      defaultVariationId: 'var-off',
      variations: [
        { id: 'var-off', key: 'off', value: false },
        { id: 'var-on', key: 'on', value: true },
      ],
      overrides: [],
      rules: [
        {
          id: 'rule-1',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: ['aud-1'],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var-on', percentage: 1 }],
        },
      ],
    }
    const makeFile = (currencyExponent?: number): FlagDatafile => ({
      version: 2,
      projectType: 'FEATURE_FLAG',
      sdkKey: 'test-sdk-key',
      environmentKey: 'test',
      publishedAt: '2026-01-01T00:00:00.000Z',
      collectEndpoint: 'https://collect.example.com',
      flags: [flag],
      audiences: [
        {
          id: 'aud-1',
          rules: {
            id: 'g-1',
            logic: 'AND',
            conditions: [cartCondition({ operator: 'gte', value: '5000' })],
          },
        },
      ],
      ...(currencyExponent === undefined ? {} : { currencyExponent }),
    })
    const ctx = makeContext({ userId: 'u_1', cartValue: 60 })

    // Exponent 0 in the datafile: threshold 5000 major → audience misses.
    expect(evaluateFlag('big-cart-banner', false, ctx, makeFile(0)).value).toBe(
      false
    )
    // Field absent: default exponent 2 → threshold 50 major → matches.
    expect(evaluateFlag('big-cart-banner', false, ctx, makeFile()).value).toBe(
      true
    )
  })
})
