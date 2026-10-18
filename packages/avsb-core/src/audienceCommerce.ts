// =====================================================================
// Commerce audience condition evaluation (e-commerce suite Phase 7).
//
// Implements the C10 server-side semantics for the three commerce
// condition types. Attributes are caller-supplied and resolved by the
// caller (`audience.ts`) through the existing kinded/legacy context
// machinery — this module only receives a resolver closure so it stays
// free of context-shape concerns (and of circular imports).
//
// Every "can't know" path (missing/mistyped attribute, non-numeric
// condition value, dataset-backed membership, unknown operator)
// evaluates to false. This module never throws.
// =====================================================================

import type { AudienceEvalOptions, Condition } from './types'

/** Resolves a commerce attribute from the caller's eval context. */
export type CommerceAttributeResolver = (attribute: string) => unknown

const DEFAULT_CURRENCY_EXPONENT = 2
const MS_PER_DAY = 86_400_000

/**
 * Evaluate one commerce condition (CART_VALUE / PRODUCTS_VIEWED /
 * PURCHASE_HISTORY). Unknown types return false, matching the
 * evaluator's fail-closed default for unrecognised condition types.
 */
export function evaluateCommerceCondition(
  condition: Condition,
  getAttribute: CommerceAttributeResolver,
  options?: AudienceEvalOptions
): boolean {
  const exponent = currencyExponentFrom(options)
  switch (condition.type) {
    case 'CART_VALUE':
      return evalCartValue(condition, getAttribute, exponent)
    case 'PRODUCTS_VIEWED':
      return evalProductsViewed(condition, getAttribute)
    case 'PURCHASE_HISTORY':
      return evalPurchaseHistory(condition, getAttribute, exponent)
    default:
      return false
  }
}

/** C5: default to exponent 2 when the datafile field is absent/invalid. */
function currencyExponentFrom(options?: AudienceEvalOptions): number {
  const exp = options?.currencyExponent
  if (typeof exp === 'number' && Number.isInteger(exp) && exp >= 0) return exp
  return DEFAULT_CURRENCY_EXPONENT
}

/**
 * Parse a minor-units integer string (C1 money encoding) into decimal
 * major units. Returns null for anything non-numeric — the caller
 * treats that as condition-evaluates-false.
 */
function parseMinorToMajor(raw: unknown, exponent: number): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const minor = Number(raw)
  if (!Number.isFinite(minor)) return null
  return minor / 10 ** exponent
}

/** Parse a plain numeric string condition value (days / counts). */
function parseNumericValue(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function singleValue(condition: Condition): unknown {
  return Array.isArray(condition.value) ? condition.value[0] : condition.value
}

// --- CART_VALUE ------------------------------------------------------

function evalCartValue(
  condition: Condition,
  getAttribute: CommerceAttributeResolver,
  exponent: number
): boolean {
  const actual = getAttribute('cartValue')
  // `cartValue` is a decimal major-units number; anything else is
  // mistyped and fails closed.
  if (typeof actual !== 'number' || !Number.isFinite(actual)) return false

  if (condition.operator === 'between') {
    if (!Array.isArray(condition.value) || condition.value.length < 2)
      return false
    const lower = parseMinorToMajor(condition.value[0], exponent)
    const upper = parseMinorToMajor(condition.value[1], exponent)
    if (lower === null || upper === null) return false
    // C1: between is inclusive on both ends.
    return actual >= lower && actual <= upper
  }

  const threshold = parseMinorToMajor(singleValue(condition), exponent)
  if (threshold === null) return false
  switch (condition.operator) {
    case 'greater_than':
      return actual > threshold
    case 'gte':
      return actual >= threshold
    case 'less_than':
      return actual < threshold
    case 'lte':
      return actual <= threshold
    default:
      return false
  }
}

// --- PRODUCTS_VIEWED -------------------------------------------------

function evalProductsViewed(
  condition: Condition,
  getAttribute: CommerceAttributeResolver
): boolean {
  // Passthrough extras carried on the wire condition (C1). The base
  // `Condition` interface doesn't declare them; read them structurally.
  const extras = condition as Condition & {
    match?: unknown
    datasetSlug?: unknown
  }

  // Dataset-backed membership cannot be resolved server-side — dataset
  // windows live in the browser. Documented FF limitation (C10):
  // conditions carrying a datasetSlug evaluate false for BOTH operators
  // (degrade-to-false beats accidental full-traffic match, C1).
  if (typeof extras.datasetSlug === 'string' && extras.datasetSlug !== '')
    return false

  // `match` picks which attribute array is consulted; `window` is
  // ignored server-side — the caller supplies whatever view list they
  // consider current (C10).
  const attributeName =
    extras.match === 'category' ? 'viewedCategories' : 'viewedSkus'
  const actual = getAttribute(attributeName)
  if (!Array.isArray(actual)) return false
  const viewed = new Set(
    actual.filter((v): v is string => typeof v === 'string')
  )

  const list = Array.isArray(condition.value)
    ? condition.value
    : [condition.value]
  const targets = list.filter(
    (v): v is string => typeof v === 'string' && v !== ''
  )
  // No membership source → both operators false (C1 asymmetry rule).
  if (targets.length === 0) return false

  const anyViewed = targets.some((t) => viewed.has(t))
  if (condition.operator === 'viewed_any') return anyViewed
  if (condition.operator === 'not_viewed_any') return !anyViewed
  return false
}

// --- PURCHASE_HISTORY ------------------------------------------------

function evalPurchaseHistory(
  condition: Condition,
  getAttribute: CommerceAttributeResolver,
  exponent: number
): boolean {
  const raw = getAttribute('purchaseHistory')
  // Frozen C10 rule: a completely absent `purchaseHistory` attribute
  // makes ALL operators false — INCLUDING has_not_purchased. Server
  // callers own their data; absence means "not provided", not "never
  // purchased" (deliberate divergence from the snippet's KV-miss
  // semantics). Mistyped values fail closed the same way.
  if (raw === null || raw === undefined) return false
  if (typeof raw !== 'object' || Array.isArray(raw)) return false
  const profile = raw as Record<string, unknown>
  const hasPurchased = profile['hasPurchased']
  if (typeof hasPurchased !== 'boolean') return false

  switch (condition.operator) {
    case 'has_purchased':
      return hasPurchased
    case 'has_not_purchased':
      return !hasPurchased
    case 'last_purchase_older_than': {
      const days = parseNumericValue(singleValue(condition))
      if (days === null) return false
      const lastPurchaseAt = profile['lastPurchaseAt']
      if (
        typeof lastPurchaseAt === 'number' &&
        Number.isFinite(lastPurchaseAt)
      ) {
        return lastPurchaseAt < Date.now() - days * MS_PER_DAY
      }
      // No usable purchase timestamp: vacuously older only when the
      // visitor has never purchased (C1); a purchaser with an unknown
      // timestamp is a "can't know" → false.
      return !hasPurchased
    }
    case 'lifetime_spend_gt': {
      const threshold = parseMinorToMajor(singleValue(condition), exponent)
      if (threshold === null) return false
      const spend = profile['lifetimeSpend']
      if (typeof spend !== 'number' || !Number.isFinite(spend)) return false
      return spend > threshold
    }
    case 'order_count_gt': {
      const min = parseNumericValue(singleValue(condition))
      if (min === null) return false
      const count = profile['orderCount']
      if (typeof count !== 'number' || !Number.isFinite(count)) return false
      return count > min
    }
    default:
      return false
  }
}
