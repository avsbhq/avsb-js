import { datafileShapeProblem } from './datafileShape'
import { evaluateFlag } from './evaluate'
import type { FlagDatafile } from './types'

function validDatafile(): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: 'sdk_test_shapecheck0000000001',
    environmentKey: 'test',
    publishedAt: '2026-10-01T00:00:00.000Z',
    collectEndpoint: 'https://collect.test.invalid',
    flags: [
      {
        id: 'flag_1',
        key: 'checkout_v2',
        type: 'boolean',
        enabled: true,
        defaultVariationId: 'var_off',
        variations: [
          { id: 'var_off', key: 'off', value: false },
          { id: 'var_on', key: 'on', value: true },
        ],
        overrides: [],
        rules: [
          {
            id: 'rule_1',
            type: 'targeted_delivery',
            enabled: true,
            audienceIds: [],
            hashAttribute: 'user.key',
            trafficAllocation: null,
            variations: [{ variationId: 'var_on', percentage: 1 }],
          },
        ],
      },
    ],
    audiences: [],
  }
}

/** A datafile with one field replaced, as the untyped JSON a caller might pass. */
function withField(path: string[], value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(validDatafile())) as Record<string, unknown>
  let target: Record<string, unknown> = copy
  for (const step of path.slice(0, -1)) {
    target = target[step] as Record<string, unknown>
  }
  target[path[path.length - 1]] = value
  return copy
}

describe('datafileShapeProblem', () => {
  it('accepts a well-formed datafile', () => {
    expect(datafileShapeProblem(validDatafile())).toBeNull()
  })

  it('accepts optional lists that are absent, and extra fields it does not know', () => {
    const datafile = { ...validDatafile(), somethingNew: { a: 1 }, holdouts: undefined }
    expect(datafileShapeProblem(datafile)).toBeNull()
  })

  it('names flags as an object, the exact bootstrap the QA passed', () => {
    expect(datafileShapeProblem({ flags: {}, audiences: [] })).toBe(
      'datafile.flags is an object, expected an array'
    )
  })

  it('names a missing audiences list', () => {
    expect(datafileShapeProblem({ flags: [] })).toBe(
      'datafile.audiences is missing, expected an array'
    )
  })

  it('rejects values that are not objects at all', () => {
    expect(datafileShapeProblem(null)).toBe('the datafile is null, expected an object')
    expect(datafileShapeProblem('{"flags":[]}')).toBe(
      'the datafile is a string, expected an object'
    )
    expect(datafileShapeProblem([])).toBe('the datafile is an array, expected an object')
  })

  it('names the broken field inside a flag and inside a rule', () => {
    expect(datafileShapeProblem(withField(['flags', '0', 'overrides'], null))).toBe(
      'datafile.flags[0].overrides is null, expected an array'
    )
    expect(
      datafileShapeProblem(withField(['flags', '0', 'rules', '0', 'audienceIds'], 'aud_1'))
    ).toBe('datafile.flags[0].rules[0].audienceIds is a string, expected an array')
    expect(datafileShapeProblem(withField(['flags', '0', 'key'], 42))).toBe(
      'datafile.flags[0].key is a number, expected a string'
    )
  })

  it('rejects an optional list that is present but not a list', () => {
    expect(datafileShapeProblem({ ...validDatafile(), holdouts: {} })).toBe(
      'datafile.holdouts is an object, expected an array when present'
    )
  })
})

describe('evaluateFlag on a malformed datafile (N0-15)', () => {
  it('returns the default instead of throwing when flags is not an array', () => {
    const malformed = { ...validDatafile(), flags: {} } as unknown as FlagDatafile
    const reasons: string[] = []
    const run = () =>
      evaluateFlag('checkout_v2', false, { kind: 'user', key: 'u1' }, malformed, undefined, reasons)

    expect(run).not.toThrow()
    const result = run()
    expect(result.value).toBe(false)
    expect(result.source).toBe('not_found')
    expect(reasons[0]).toBe(
      'flag "checkout_v2" cannot be evaluated: the datafile has no flags array'
    )
  })

  it('treats a malformed audiences list as no audiences rather than throwing', () => {
    const datafile = validDatafile()
    datafile.flags[0].rules[0].audienceIds = ['aud_paid']
    const malformed = { ...datafile, audiences: {} } as unknown as FlagDatafile

    const result = evaluateFlag('checkout_v2', false, { kind: 'user', key: 'u1' }, malformed)
    expect(result.source).toBe('default')
  })

  it('treats a malformed holdouts list as no holdouts rather than throwing', () => {
    const malformed = { ...validDatafile(), holdouts: {} } as unknown as FlagDatafile
    const result = evaluateFlag('checkout_v2', false, { kind: 'user', key: 'u1' }, malformed)
    expect(result.source).toBe('rule')
    expect(result.value).toBe(true)
  })
})
