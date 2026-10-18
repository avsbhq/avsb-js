import type {
  AudienceEvalOptions,
  FlagDatafileAudience,
  ConditionGroup,
  Condition,
  EvalContext,
  LegacyEvalContext,
  SingleContext,
} from './types'
import { isConditionGroup } from './types'
import { getContextByKind, isMultiContext } from './context'
import { evaluateCommerceCondition } from './audienceCommerce'
import { evalSemverOperator } from './semver'

const isBrowser =
  typeof window !== 'undefined' && typeof navigator !== 'undefined'

/**
 * Internal context shape consumed by the audience evaluator. The
 * evaluator accepts both the new `EvalContext` (kinded) shape and the
 * legacy single-bag `{ attributes }` shape so existing callers keep
 * working through the in-flight migration.
 */
export type AudienceEvalContext = EvalContext | LegacyEvalContext

function isLegacyContext(ctx: AudienceEvalContext): ctx is LegacyEvalContext {
  return (
    typeof (ctx as { attributes?: unknown }).attributes === 'object' &&
    (ctx as { attributes?: unknown }).attributes !== null &&
    !('kind' in ctx)
  )
}

const RESERVED_KEYS = new Set(['kind', 'key', 'name', '_meta'])

/**
 * Resolve a (contextKind, attribute) pair from any supported context shape.
 *
 *  - For an `EvalContext` with a matching kind, attribute='key' returns
 *    that sub-context's `key`; otherwise the sub-context's attribute bag
 *    is consulted.
 *  - For a `LegacyEvalContext`, the lookup falls back to
 *    `attributes[attribute]` (kind ignored).
 *  - Returns `undefined` when the kind is absent or the attribute is not
 *    set on the resolved sub-context.
 */
function resolveAttribute(
  ctx: AudienceEvalContext,
  contextKind: string | undefined,
  attribute: string
): unknown {
  if (isLegacyContext(ctx)) {
    return ctx.attributes[attribute]
  }
  // EvalContext branch
  if (contextKind) {
    const sub = getContextByKind(ctx, contextKind)
    if (!sub) return undefined
    return readSubContextAttribute(sub, attribute)
  }
  // No contextKind declared on the condition — fall back to legacy
  // single-context lookup: use the primary single context (the
  // SingleContext itself, or the 'user' sub-context of a multi).
  const primary: SingleContext | null = isMultiContext(ctx)
    ? getContextByKind(ctx, 'user')
    : ctx
  if (!primary) return undefined
  // Legacy bag also exposed `userId` for the primary key — preserve that.
  if (attribute === 'userId') return primary.key
  return readSubContextAttribute(primary, attribute)
}

function readSubContextAttribute(
  sub: SingleContext,
  attribute: string
): unknown {
  if (attribute === 'key') return sub.key
  if (attribute === 'name') return sub.name
  if (RESERVED_KEYS.has(attribute)) return undefined
  return sub[attribute]
}

export function evaluateAudience(
  audience: FlagDatafileAudience,
  context: AudienceEvalContext,
  options?: AudienceEvalOptions
): boolean {
  if (!audience || !audience.rules) return true
  return evaluateGroup(audience.rules, context, options)
}

export function evaluateGroup(
  group: ConditionGroup,
  context: AudienceEvalContext,
  options?: AudienceEvalOptions
): boolean {
  if (
    !group ||
    !Array.isArray(group.conditions) ||
    group.conditions.length === 0
  )
    return true

  if (group.logic === 'AND') {
    return group.conditions.every((item) =>
      isConditionGroup(item)
        ? evaluateGroup(item, context, options)
        : evaluateCondition(item, context, options)
    )
  }
  return group.conditions.some((item) =>
    isConditionGroup(item)
      ? evaluateGroup(item, context, options)
      : evaluateCondition(item, context, options)
  )
}

export function evaluateCondition(
  condition: Condition,
  context: AudienceEvalContext,
  options?: AudienceEvalOptions
): boolean {
  switch (condition.type) {
    case 'CUSTOM_ATTRIBUTE':
      return evalCustomAttribute(condition, context)
    // Commerce conditions (e-commerce suite Phase 7, C10) — evaluated
    // from caller-supplied attributes resolved through the same
    // kinded/legacy machinery as CUSTOM_ATTRIBUTE. Money values on the
    // condition are minor units, converted to major via
    // `options.currencyExponent` (FF datafile C5, default 2).
    case 'CART_VALUE':
    case 'PRODUCTS_VIEWED':
    case 'PURCHASE_HISTORY':
      return evaluateCommerceCondition(
        condition,
        (attribute) =>
          resolveAttribute(context, condition.contextKind, attribute),
        options
      )
    case 'DEVICE':
      return isBrowser ? evalDevice(condition) : false
    case 'BROWSER':
      return isBrowser ? evalBrowser(condition) : false
    case 'PLATFORM':
      return isBrowser ? evalPlatform(condition) : false
    case 'LANGUAGE':
      return isBrowser ? evalLanguage(condition) : false
    case 'COOKIE':
      return isBrowser ? evalCookie(condition) : false
    case 'QUERY_PARAM':
      return isBrowser ? evalQueryParam(condition) : false
    default:
      return false
  }
}

// --- Custom attribute evaluation ---

function evalCustomAttribute(
  condition: Condition,
  context: AudienceEvalContext
): boolean {
  const attrKey = condition.attribute
  if (!attrKey) return false

  // When a contextKind is declared on the condition and the eval context
  // is the new kinded shape, the sub-context must exist for the condition
  // to even be evaluable. A missing kind is a hard "no-match" — it is not
  // semantically equivalent to a missing attribute (which can still match
  // `not_exists`).
  if (condition.contextKind && !isLegacyContext(context)) {
    const sub = getContextByKind(context, condition.contextKind)
    if (!sub) return false
  }

  const actual = resolveAttribute(context, condition.contextKind, attrKey)
  const expected = Array.isArray(condition.value)
    ? condition.value[0]
    : condition.value

  // Alias operators (`is`, `is_not`, `does_not_contain`, `does_not_exist`)
  // are the names the dashboard audience builder writes for the
  // device/browser condition types. They reach CUSTOM_ATTRIBUTE
  // conditions too, so every case below carries its alias (spec §1.4
  // operator matrix, locked by the conformance corpus). Before this,
  // an audience saved with `is` fell through to the default branch and
  // silently matched nobody.
  switch (condition.operator) {
    case 'exists':
      return actual !== undefined && actual !== null
    case 'not_exists':
    case 'does_not_exist':
      return actual === undefined || actual === null
    case 'equals':
    case 'is':
      return String(actual) === String(expected)
    case 'not_equals':
    case 'is_not':
      return String(actual) !== String(expected)
    case 'contains':
      return String(actual).toLowerCase().includes(String(expected).toLowerCase())
    case 'not_contains':
    case 'does_not_contain':
      return !String(actual).toLowerCase().includes(String(expected).toLowerCase())
    case 'starts_with':
      return String(actual).toLowerCase().startsWith(String(expected).toLowerCase())
    case 'ends_with':
      return String(actual).toLowerCase().endsWith(String(expected).toLowerCase())
    case 'regex':
      try {
        return new RegExp(String(expected), 'i').test(String(actual))
      } catch {
        return false
      }
    case 'greater_than':
      return Number(actual) > Number(expected)
    case 'less_than':
      return Number(actual) < Number(expected)
    case 'gte':
      return Number(actual) >= Number(expected)
    case 'lte':
      return Number(actual) <= Number(expected)
    case 'in_list': {
      const list = Array.isArray(condition.value) ? condition.value : [condition.value]
      return list.some((v) => String(actual) === String(v))
    }
    case 'not_in_list': {
      const list = Array.isArray(condition.value) ? condition.value : [condition.value]
      return list.every((v) => String(actual) !== String(v))
    }
    // Version-number comparison (`./semver.ts`). An SDK released before these
    // operators existed reaches `default` and answers false, which is the
    // documented behaviour of an older SDK.
    case 'semver_eq':
    case 'semver_neq':
    case 'semver_gt':
    case 'semver_gte':
    case 'semver_lt':
    case 'semver_lte':
      return evalSemverOperator(condition.operator, actual, expected)
    default:
      return false
  }
}

// --- Browser-detected conditions ---

function matchOperator(actual: string, operator: string, expected: string): boolean {
  const a = actual.toLowerCase()
  const e = expected.toLowerCase()
  switch (operator) {
    case 'equals':
    case 'is':
      return a === e
    case 'not_equals':
    case 'is_not':
      return a !== e
    case 'contains':
      return a.includes(e)
    case 'not_contains':
    case 'does_not_contain':
      return !a.includes(e)
    case 'starts_with':
      return a.startsWith(e)
    case 'ends_with':
      return a.endsWith(e)
    case 'regex':
      try {
        return new RegExp(expected, 'i').test(actual)
      } catch {
        return false
      }
    case 'exists':
      return actual.length > 0
    case 'not_exists':
    case 'does_not_exist':
      return actual.length === 0
    default:
      return false
  }
}

function matchMultiValue(
  actual: string,
  operator: string,
  values: string[]
): boolean {
  if (values.length === 0) return true
  const isNegated = operator === 'is_not' || operator === 'not_equals'
  if (isNegated) {
    return values.every((v) => matchOperator(actual, 'not_equals', v))
  }
  return values.some((v) => matchOperator(actual, 'equals', v))
}

function detectDevice(): string {
  const ua = navigator.userAgent.toLowerCase()
  if (/tablet|ipad|playbook|silk/.test(ua)) return 'tablet'
  if (/mobile|iphone|ipod|android.*mobile|windows phone|blackberry/.test(ua))
    return 'mobile'
  return 'desktop'
}

function evalDevice(c: Condition): boolean {
  if (Array.isArray(c.value) && c.value.length > 0) {
    return matchMultiValue(detectDevice(), c.operator, c.value)
  }
  const val = typeof c.value === 'string' ? c.value : ''
  return matchOperator(detectDevice(), c.operator, val)
}

function detectBrowser(): string {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('edg/') || ua.includes('edgios')) return 'edge'
  if (ua.includes('opr/') || ua.includes('opera')) return 'opera'
  if (ua.includes('chrome') || ua.includes('crios')) return 'chrome'
  if (ua.includes('firefox') || ua.includes('fxios')) return 'firefox'
  if (ua.includes('safari')) return 'safari'
  return 'other'
}

function evalBrowser(c: Condition): boolean {
  if (Array.isArray(c.value) && c.value.length > 0) {
    return matchMultiValue(detectBrowser(), c.operator, c.value)
  }
  const val = typeof c.value === 'string' ? c.value : ''
  return matchOperator(detectBrowser(), c.operator, val)
}

function detectPlatform(): string {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod'))
    return 'ios'
  if (ua.includes('android')) return 'android'
  if (ua.includes('win')) return 'windows'
  if (ua.includes('mac')) return 'macos'
  if (ua.includes('linux')) return 'linux'
  return 'other'
}

function evalPlatform(c: Condition): boolean {
  if (Array.isArray(c.value) && c.value.length > 0) {
    return matchMultiValue(detectPlatform(), c.operator, c.value)
  }
  const val = typeof c.value === 'string' ? c.value : ''
  return matchOperator(detectPlatform(), c.operator, val)
}

function evalLanguage(c: Condition): boolean {
  const langPrefix = navigator.language.toLowerCase().split('-')[0]
  if (Array.isArray(c.value) && c.value.length > 0) {
    return matchMultiValue(langPrefix, c.operator, c.value)
  }
  const val = typeof c.value === 'string' ? c.value : ''
  return matchOperator(langPrefix, c.operator, val)
}

function parseCookies(): Record<string, string> {
  const cookies: Record<string, string> = {}
  document.cookie.split(';').forEach((pair) => {
    const idx = pair.indexOf('=')
    if (idx === -1) return
    cookies[pair.substring(0, idx).trim()] = decodeURIComponent(
      pair.substring(idx + 1).trim()
    )
  })
  return cookies
}

function evalCookie(c: Condition): boolean {
  const val = Array.isArray(c.value) ? c.value[0] : c.value
  const sepIdx = val.indexOf(':')
  const name = sepIdx === -1 ? val : val.substring(0, sepIdx)
  const expected = sepIdx === -1 ? '' : val.substring(sepIdx + 1)
  const cookies = parseCookies()
  const actual = cookies[name] ?? ''

  if (c.operator === 'exists') return name in cookies
  if (c.operator === 'not_exists' || c.operator === 'does_not_exist')
    return !(name in cookies)
  return matchOperator(actual, c.operator, expected)
}

function evalQueryParam(c: Condition): boolean {
  const val = Array.isArray(c.value) ? c.value[0] : c.value
  const sepIdx = val.indexOf(':')
  const name = sepIdx === -1 ? val : val.substring(0, sepIdx)
  const expected = sepIdx === -1 ? '' : val.substring(sepIdx + 1)
  const params = new URLSearchParams(window.location.search)
  const actual = params.get(name)

  if (c.operator === 'exists') return params.has(name)
  if (c.operator === 'not_exists' || c.operator === 'does_not_exist')
    return !params.has(name)
  return matchOperator(actual ?? '', c.operator, expected)
}
