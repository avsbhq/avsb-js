import { describe, it, expect } from 'vitest'
import {
  compareSemver,
  evalSemverOperator,
  isSemverOperator,
  parseSemver,
  SEMVER_OPERATORS,
} from './semver'
import type { ParsedSemver } from './semver'

function parsed(
  major: string,
  minor: string,
  patch: string,
  prerelease: string[] = []
): ParsedSemver {
  return { major, minor, patch, prerelease }
}

/** Parse both sides, failing the test loudly when either does not parse. */
function order(a: string, b: string): -1 | 0 | 1 {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (left === null || right === null) {
    throw new Error(`test table row does not parse: ${a} / ${b}`)
  }
  return compareSemver(left, right)
}

describe('parseSemver: what parses', () => {
  it.each<[string, ParsedSemver]>([
    ['1.2.3', parsed('1', '2', '3')],
    ['0.0.0', parsed('0', '0', '0')],
    ['v1.2.3', parsed('1', '2', '3')],
    ['V1.2.3', parsed('1', '2', '3')],
    ['2', parsed('2', '0', '0')],
    ['2.3', parsed('2', '3', '0')],
    ['v2', parsed('2', '0', '0')],
    ['  2.3.0\t', parsed('2', '3', '0')],
    ['\n\v\f1.0.0\r\n', parsed('1', '0', '0')],
    ['1.0.0-alpha', parsed('1', '0', '0', ['alpha'])],
    ['1.0.0-alpha.1', parsed('1', '0', '0', ['alpha', '1'])],
    ['1.0.0-0.3.7', parsed('1', '0', '0', ['0', '3', '7'])],
    ['1.0.0-x-y-z.--', parsed('1', '0', '0', ['x-y-z', '--'])],
    ['1.0.0-0a', parsed('1', '0', '0', ['0a'])],
    ['1.0.0+20130313144700', parsed('1', '0', '0')],
    ['1.0.0-beta+exp.sha.5114f85', parsed('1', '0', '0', ['beta'])],
    ['1.0.0+21AF26D3----117B344092BD', parsed('1', '0', '0')],
    ['1.0.0+001', parsed('1', '0', '0')],
    ['2-beta', parsed('2', '0', '0', ['beta'])],
    ['1-2.3', parsed('1', '0', '0', ['2', '3'])],
    ['18446744073709551616.0.0', parsed('18446744073709551616', '0', '0')],
  ])('reads %j', (input, expected) => {
    expect(parseSemver(input)).toEqual(expected)
  })
})

describe('parseSemver: what does not parse', () => {
  it.each([
    '',
    '   ',
    'v',
    'V',
    'banana',
    '2.x',
    '1.2.3.4',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3-',
    '1.2.3+',
    '1.2.3-alpha..1',
    '1.2.3+build..1',
    '1.',
    '.1',
    '1..2',
    'vv1.2.3',
    'v 1.2.3',
    '1.2.3 beta',
    '1.2.3-beta_1',
    '1.2.3-béta',
    '١.٢.٣',
    '1.2.3+build+more',
    '=1.2.3',
    '-1.2.3',
    '+1.2.3',
    '1.2.3 ',
    ' 1.2.3',
    '1.2.3\n2.0.0',
    ' 1 .2.3',
  ])('refuses %j', (input) => {
    expect(parseSemver(input)).toBeNull()
  })
})

describe('compareSemver', () => {
  it.each<[string, string, -1 | 0 | 1]>([
    ['1.0.0', '2.0.0', -1],
    ['2.0.0', '2.1.0', -1],
    ['2.1.0', '2.1.1', -1],
    ['2.10.0', '2.9.1', 1],
    ['1.0.0', '1.0.0', 0],
    ['2', '2.0.0', 0],
    ['v2.3', '2.3.0', 0],
    ['1.0.0+build1', '1.0.0+build2', 0],
    ['1.0.0-rc.1+build.5', '1.0.0-rc.1', 0],
    ['1.0.0-alpha', '1.0.0', -1],
    ['1.0.0-Beta', '1.0.0-alpha', -1],
    ['1.0.0-1', '1.0.0-a', -1],
    ['1.0.0-2', '1.0.0-10', -1],
    ['1.0.0-a-b', '1.0.0-a', 1],
    ['18446744073709551616.0.0', '18446744073709551615.0.0', 1],
    ['99999999999999999999.0.0', '100000000000000000000.0.0', -1],
  ])('%s against %s is %i', (a, b, expected) => {
    expect(order(a, b)).toBe(expected)
    expect(order(b, a)).toBe(expected === 0 ? 0 : -expected)
  })

  it('orders the SemVer 2.0.0 section 11 pre-release chain', () => {
    const chain = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ]
    for (let i = 0; i < chain.length - 1; i++) {
      expect(order(chain[i], chain[i + 1]), `${chain[i]} < ${chain[i + 1]}`).toBe(-1)
      expect(order(chain[i + 1], chain[i]), `${chain[i + 1]} > ${chain[i]}`).toBe(1)
    }
  })
})

describe('evalSemverOperator', () => {
  it.each<[string, string, string, boolean]>([
    ['semver_eq', '2.3.0', '2.3', true],
    ['semver_eq', '2.3.1', '2.3', false],
    ['semver_neq', '2.3.1', '2.3.0', true],
    ['semver_neq', 'v2.3.0', '2.3', false],
    ['semver_gt', '2.10.0', '2.9.1', true],
    ['semver_gt', '2.9.1', '2.9.1', false],
    ['semver_gte', '2.9.1', '2.9.1', true],
    ['semver_gte', '2.9.0', '2.9.1', false],
    ['semver_lt', '2.0.0-beta.2', '2.0.0', true],
    ['semver_lt', '2.0.0', '2.0.0', false],
    ['semver_lte', '2.0.0', '2.0.0', true],
    ['semver_lte', '2.0.1', '2.0.0', false],
  ])('%s: %s against %s is %s', (operator, actual, expected, result) => {
    expect(evalSemverOperator(operator, actual, expected)).toBe(result)
  })

  it('reads a number attribute through String(n)', () => {
    expect(evalSemverOperator('semver_eq', 2, '2.0.0')).toBe(true)
    expect(evalSemverOperator('semver_lt', 2.5, '2.10.0')).toBe(true)
    expect(evalSemverOperator('semver_gte', -2, '0.0.0')).toBe(false)
  })

  it('answers false for every operator when the attribute is not a string or number', () => {
    for (const operator of SEMVER_OPERATORS) {
      for (const actual of [true, false, null, undefined, {}, ['2.0.0']]) {
        expect(evalSemverOperator(operator, actual, '2.0.0'), `${operator} ${String(actual)}`).toBe(
          false
        )
      }
    }
  })

  it('answers false for every operator, semver_neq included, when either side does not parse', () => {
    for (const operator of SEMVER_OPERATORS) {
      expect(evalSemverOperator(operator, '3.0.0', '2.x'), `${operator} bad rule`).toBe(false)
      expect(evalSemverOperator(operator, '1.2.3.4', '2.0.0'), `${operator} bad actual`).toBe(false)
    }
  })

  it('requires the rule value to be a string', () => {
    expect(evalSemverOperator('semver_eq', '2.0.0', 2)).toBe(false)
    expect(evalSemverOperator('semver_eq', '2.0.0', undefined)).toBe(false)
  })

  it('answers false for an operator outside the six', () => {
    expect(evalSemverOperator('semver_between', '2.0.0', '2.0.0')).toBe(false)
    expect(evalSemverOperator('equals', '2.0.0', '2.0.0')).toBe(false)
  })
})

describe('isSemverOperator', () => {
  it('knows the six operators and nothing else', () => {
    expect(SEMVER_OPERATORS).toEqual([
      'semver_eq',
      'semver_neq',
      'semver_gt',
      'semver_gte',
      'semver_lt',
      'semver_lte',
    ])
    for (const operator of SEMVER_OPERATORS) expect(isSemverOperator(operator)).toBe(true)
    expect(isSemverOperator('greater_than')).toBe(false)
    expect(isSemverOperator('SEMVER_EQ')).toBe(false)
  })
})
