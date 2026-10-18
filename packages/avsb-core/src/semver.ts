// =====================================================================
// Version-number comparison for the six `semver_*` audience operators.
//
// One grammar, written once here and mirrored by every SDK port (Go, the
// agent, Java, PHP, Ruby, .NET, Python) and by the dashboard validator:
//
//   Parse (lenient on input):
//     - surrounding ASCII whitespace (space, tab, LF, VT, FF, CR) is trimmed;
//     - one optional leading `v` or `V`;
//     - one to three dot-separated numeric identifiers: digits only, no
//       leading zero unless the identifier is exactly `0`; a missing minor or
//       patch reads as 0 (`2` is 2.0.0, `2.3` is 2.3.0);
//     - an optional `-prerelease`: dot-separated, non-empty identifiers of
//       [0-9A-Za-z-]; a digits-only identifier has no leading zero;
//     - an optional `+build`: dot-separated, non-empty identifiers of
//       [0-9A-Za-z-]; checked, then ignored by every comparison.
//     Anything else does not parse.
//
//   Compare (strict on order, SemVer 2.0.0 section 11):
//     - major, minor, patch numerically, at any size (digit strings compare
//       by length first, then digit by digit, so no port can overflow);
//     - a version with a pre-release is lower than the same version without;
//     - pre-release identifiers left to right: digits-only ones numerically,
//       others by ASCII, a digits-only identifier lower than any other, and
//       the shorter list lower when every earlier identifier is equal.
//
// Operators never throw. A value that is not a string (a number actual is
// first converted with `String(n)`), or a side that does not parse, makes the
// condition false, `semver_neq` included.
//
// Pinned by the `operator_semver_*` cases of the conformance corpus
// (packages/avsb-conformance/src/families/operatorCases.ts).
// =====================================================================

/** The six operators, in the order the audience builder offers them. */
export const SEMVER_OPERATORS = [
  'semver_eq',
  'semver_neq',
  'semver_gt',
  'semver_gte',
  'semver_lt',
  'semver_lte',
] as const

export type SemverOperator = (typeof SEMVER_OPERATORS)[number]

/** A parsed version. Numeric parts are canonical digit strings. */
export interface ParsedSemver {
  major: string
  minor: string
  patch: string
  /** Pre-release identifiers; empty for a release. Build metadata is dropped. */
  prerelease: string[]
}

const SEMVER_OPERATOR_SET: ReadonlySet<string> = new Set(SEMVER_OPERATORS)

/** Most numeric identifiers in the version core: major, minor, patch. */
const MAX_CORE_PARTS = 3

export function isSemverOperator(operator: string): operator is SemverOperator {
  return SEMVER_OPERATOR_SET.has(operator)
}

function isAsciiWhitespace(ch: string): boolean {
  return (
    ch === ' ' ||
    ch === '\t' ||
    ch === '\n' ||
    ch === '\v' ||
    ch === '\f' ||
    ch === '\r'
  )
}

function isAsciiDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isIdentifierChar(ch: string): boolean {
  return (
    isAsciiDigit(ch) ||
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= 'a' && ch <= 'z') ||
    ch === '-'
  )
}

function isAllDigits(value: string): boolean {
  if (value.length === 0) return false
  for (const ch of value) {
    if (!isAsciiDigit(ch)) return false
  }
  return true
}

/** Digits only, and no leading zero unless the identifier is exactly `0`. */
function isNumericIdentifier(value: string): boolean {
  return isAllDigits(value) && (value.length === 1 || value[0] !== '0')
}

/** Non-empty and made only of [0-9A-Za-z-]. */
function isDotIdentifier(value: string): boolean {
  if (value.length === 0) return false
  for (const ch of value) {
    if (!isIdentifierChar(ch)) return false
  }
  return true
}

function isPrereleaseIdentifier(value: string): boolean {
  if (!isDotIdentifier(value)) return false
  return !isAllDigits(value) || isNumericIdentifier(value)
}

function trimAsciiWhitespace(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && isAsciiWhitespace(value[start])) start++
  while (end > start && isAsciiWhitespace(value[end - 1])) end--
  return value.slice(start, end)
}

/** Read a version string, or `null` when it does not follow the grammar. */
export function parseSemver(input: string): ParsedSemver | null {
  let text = trimAsciiWhitespace(input)
  if (text.startsWith('v') || text.startsWith('V')) text = text.slice(1)

  const plus = text.indexOf('+')
  if (plus !== -1) {
    const build = text.slice(plus + 1).split('.')
    if (!build.every(isDotIdentifier)) return null
    text = text.slice(0, plus)
  }

  let prerelease: string[] = []
  const dash = text.indexOf('-')
  if (dash !== -1) {
    prerelease = text.slice(dash + 1).split('.')
    if (!prerelease.every(isPrereleaseIdentifier)) return null
    text = text.slice(0, dash)
  }

  const parts = text.split('.')
  if (parts.length > MAX_CORE_PARTS) return null
  if (!parts.every(isNumericIdentifier)) return null

  return {
    major: parts[0],
    minor: parts[1] ?? '0',
    patch: parts[2] ?? '0',
    prerelease,
  }
}

function sign(value: number): -1 | 0 | 1 {
  if (value < 0) return -1
  if (value > 0) return 1
  return 0
}

/** Two canonical digit strings, compared as the integers they spell. */
function compareNumeric(a: string, b: string): -1 | 0 | 1 {
  if (a.length !== b.length) return sign(a.length - b.length)
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function comparePrereleaseIdentifier(a: string, b: string): -1 | 0 | 1 {
  const aNumeric = isAllDigits(a)
  const bNumeric = isAllDigits(b)
  if (aNumeric && bNumeric) return compareNumeric(a, b)
  if (aNumeric) return -1
  if (bNumeric) return 1
  // ASCII order: both sides are [0-9A-Za-z-] only, so code units are bytes.
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** SemVer 2.0.0 precedence: -1 when `a` is lower, 1 when higher, 0 when equal. */
export function compareSemver(a: ParsedSemver, b: ParsedSemver): -1 | 0 | 1 {
  const core =
    compareNumeric(a.major, b.major) ||
    compareNumeric(a.minor, b.minor) ||
    compareNumeric(a.patch, b.patch)
  if (core !== 0) return core

  const aRelease = a.prerelease.length === 0
  const bRelease = b.prerelease.length === 0
  if (aRelease && bRelease) return 0
  if (aRelease) return 1
  if (bRelease) return -1

  const shared = Math.min(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < shared; i++) {
    const order = comparePrereleaseIdentifier(a.prerelease[i], b.prerelease[i])
    if (order !== 0) return order
  }
  return sign(a.prerelease.length - b.prerelease.length)
}

/** The version text of a context value: a string as is, a number as `String(n)`. */
function versionText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return null
}

/**
 * Answer one `semver_*` condition. `actual` is the context attribute,
 * `expected` the rule value. Never throws; anything unreadable is false.
 */
export function evalSemverOperator(
  operator: string,
  actual: unknown,
  expected: unknown
): boolean {
  if (!isSemverOperator(operator)) return false
  const actualText = versionText(actual)
  if (actualText === null || typeof expected !== 'string') return false
  const actualVersion = parseSemver(actualText)
  const expectedVersion = parseSemver(expected)
  if (actualVersion === null || expectedVersion === null) return false

  const order = compareSemver(actualVersion, expectedVersion)
  switch (operator) {
    case 'semver_eq':
      return order === 0
    case 'semver_neq':
      return order !== 0
    case 'semver_gt':
      return order > 0
    case 'semver_gte':
      return order >= 0
    case 'semver_lt':
      return order < 0
    case 'semver_lte':
      return order <= 0
  }
}
