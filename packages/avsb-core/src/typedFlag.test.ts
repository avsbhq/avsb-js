import { describe, it, expect } from 'vitest'
import { checkExpectedType, findDatafileFlag } from './typedFlag'
import type { FlagDatafile, FlagDatafileEntry } from './types'

function flag(type: FlagDatafileEntry['type']): FlagDatafileEntry {
  return {
    id: 'f-1',
    key: 'k',
    type,
    enabled: true,
    defaultVariationId: 'v-1',
    variations: [{ id: 'v-1', key: 'v', value: undefined }],
    overrides: [],
    rules: [],
  }
}

describe('checkExpectedType — boolean', () => {
  it('returns null when the flag is boolean and the value is boolean', () => {
    expect(checkExpectedType(flag('boolean'), 'boolean', true)).toBeNull()
    expect(checkExpectedType(flag('boolean'), 'boolean', false)).toBeNull()
  })

  it('returns a reason when the flag is declared as a different type', () => {
    expect(checkExpectedType(flag('string'), 'boolean', true)).toMatch(
      /declared as "string"/
    )
  })

  it('returns a reason when the value type does not match', () => {
    expect(checkExpectedType(flag('boolean'), 'boolean', 'yes')).toMatch(
      /non-boolean/
    )
  })
})

describe('checkExpectedType — string/number/json', () => {
  it('strings: type matches but value is wrong → flagged', () => {
    expect(checkExpectedType(flag('string'), 'string', 42)).toMatch(/non-string/)
  })

  it('numbers: NaN counts as a type mismatch', () => {
    expect(checkExpectedType(flag('number'), 'number', NaN)).toMatch(
      /non-number/
    )
  })

  it('json: undefined is flagged but objects/arrays/primitives pass', () => {
    expect(checkExpectedType(flag('json'), 'json', undefined)).toMatch(/undefined/)
    expect(checkExpectedType(flag('json'), 'json', { a: 1 })).toBeNull()
    expect(checkExpectedType(flag('json'), 'json', [1, 2, 3])).toBeNull()
    expect(checkExpectedType(flag('json'), 'json', 'x')).toBeNull()
  })
})

describe('checkExpectedType — missing flag', () => {
  it('returns a reason when the flag is missing from the datafile', () => {
    expect(checkExpectedType(undefined, 'boolean', false)).toMatch(
      /was not found in the datafile/
    )
  })
})

describe('findDatafileFlag', () => {
  it('returns the flag entry when present', () => {
    const df: FlagDatafile = {
      version: 2,
      projectType: 'FEATURE_FLAG',
      sdkKey: 'k',
      environmentKey: 'env',
      publishedAt: '2026-05-28T00:00:00.000Z',
      collectEndpoint: 'https://collect.example.com',
      flags: [flag('boolean')],
      audiences: [],
    }
    expect(findDatafileFlag(df, 'k')?.key).toBe('k')
  })

  it('returns undefined when the flag is absent', () => {
    const df: FlagDatafile = {
      version: 2,
      projectType: 'FEATURE_FLAG',
      sdkKey: 'k',
      environmentKey: 'env',
      publishedAt: '2026-05-28T00:00:00.000Z',
      collectEndpoint: 'https://collect.example.com',
      flags: [],
      audiences: [],
    }
    expect(findDatafileFlag(df, 'missing')).toBeUndefined()
  })

  it('returns undefined when the datafile is null', () => {
    expect(findDatafileFlag(null, 'x')).toBeUndefined()
  })
})
