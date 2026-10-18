import { describe, it, expect } from 'vitest'
import {
  createFlag,
  notFoundFlag,
  notReadyFlag,
  mapLegacySource,
} from './flag'
import type { EvaluationSource } from './types'

describe('createFlag', () => {
  it('returns a frozen Flag object', () => {
    const flag = createFlag<boolean>({
      value: true,
      variationKey: 'on',
      source: 'rule',
      ruleId: 'r-1',
      ruleType: 'ab_test',
      reasons: ['matched rule r-1'],
    })
    expect(Object.isFrozen(flag)).toBe(true)
    expect(flag.value).toBe(true)
    expect(flag.variationKey).toBe('on')
  })

  it('populates evaluatedAt and durationMicros with sensible defaults', () => {
    const before = Date.now()
    const flag = createFlag<string>({
      value: 'x',
      variationKey: 'v',
      source: 'rule',
      ruleId: 'r',
      ruleType: 'ab_test',
      reasons: [],
    })
    expect(flag.evaluatedAt).toBeGreaterThanOrEqual(before)
    expect(flag.durationMicros).toBe(0)
  })

  it('isEnabled() is true when served by a rule with a truthy value', () => {
    expect(
      createFlag({
        value: true,
        variationKey: 'on',
        source: 'rule',
        ruleId: 'r',
        ruleType: 'ab_test',
        reasons: [],
      }).isEnabled()
    ).toBe(true)
    expect(
      createFlag({
        value: false,
        variationKey: 'off',
        source: 'rule',
        ruleId: 'r',
        ruleType: 'ab_test',
        reasons: [],
      }).isEnabled()
    ).toBe(false)
  })

  it('isEnabled() is false when the source is the default fallback', () => {
    expect(
      createFlag({
        value: true,
        variationKey: null,
        source: 'default',
        ruleId: null,
        ruleType: null,
        reasons: [],
      }).isEnabled()
    ).toBe(false)
  })

  it('exists() is true for any source except not_found and not_ready', () => {
    expect(
      createFlag({
        value: 'x',
        variationKey: 'v',
        source: 'default',
        ruleId: null,
        ruleType: null,
        reasons: [],
      }).exists()
    ).toBe(true)
    expect(
      createFlag({
        value: 'x',
        variationKey: null,
        source: 'not_found',
        ruleId: null,
        ruleType: null,
        reasons: ['flag not in datafile'],
      }).exists()
    ).toBe(false)
    expect(
      createFlag({
        value: 'x',
        variationKey: null,
        source: 'not_ready',
        ruleId: null,
        ruleType: null,
        reasons: ['sdk not initialised'],
      }).exists()
    ).toBe(false)
  })

  // Spec §1.4 lock: this table is mirrored in the conformance corpus
  // (fixtures/semantics/manifest.json) and every language port asserts
  // the same rows. A source moving between the two groups is a
  // cross-language behaviour change, not a refactor.
  describe('isEnabled() truth table (spec §1.4)', () => {
    const decided: EvaluationSource[] = [
      'rule',
      'holdout',
      'bandit',
      'runtimeOverride',
      'datafileOverride',
      'sticky',
    ]
    const notDecided: EvaluationSource[] = [
      'default',
      'not_found',
      'disabled',
      'not_ready',
    ]

    for (const source of decided) {
      it(`is true for a truthy value from ${source}`, () => {
        expect(
          createFlag({
            value: true,
            variationKey: 'on',
            source,
            ruleId: null,
            ruleType: null,
            reasons: [],
          }).isEnabled()
        ).toBe(true)
      })

      it(`is false for a falsy value from ${source}`, () => {
        expect(
          createFlag({
            value: 0,
            variationKey: 'off',
            source,
            ruleId: null,
            ruleType: null,
            reasons: [],
          }).isEnabled()
        ).toBe(false)
      })
    }

    for (const source of notDecided) {
      it(`is false for ${source} even when the value is truthy`, () => {
        expect(
          createFlag({
            value: 'yes',
            variationKey: null,
            source,
            ruleId: null,
            ruleType: null,
            reasons: [],
          }).isEnabled()
        ).toBe(false)
      })
    }
  })
})

describe('notFoundFlag', () => {
  it('returns a frozen sentinel for missing flags', () => {
    const flag = notFoundFlag<number>(42, 'flag "x" not in datafile')
    expect(flag.value).toBe(42)
    expect(flag.source).toBe('not_found')
    expect(flag.variationKey).toBeNull()
    expect(flag.exists()).toBe(false)
    expect(Object.isFrozen(flag)).toBe(true)
  })
})

describe('notReadyFlag', () => {
  it('returns the caller default with source not_ready', () => {
    const flag = notReadyFlag<string>('fallback', 'sdk not initialised')
    expect(flag.value).toBe('fallback')
    expect(flag.source).toBe('not_ready')
    expect(flag.variationKey).toBeNull()
    expect(Object.isFrozen(flag)).toBe(true)
  })

  it('is neither enabled nor existing, and is distinct from not_found', () => {
    const notReady = notReadyFlag<boolean>(true, 'sdk not initialised')
    expect(notReady.isEnabled()).toBe(false)
    expect(notReady.exists()).toBe(false)
    expect(notReady.source).not.toBe(notFoundFlag(true, 'x').source)
  })
})

describe('mapLegacySource', () => {
  it('maps override → datafileOverride', () => {
    expect(mapLegacySource('override')).toBe('datafileOverride')
  })

  it('maps runtime_override → runtimeOverride', () => {
    expect(mapLegacySource('runtime_override')).toBe('runtimeOverride')
  })

  it('passes through sticky/rule/default/not_found/disabled unchanged', () => {
    expect(mapLegacySource('sticky')).toBe('sticky')
    expect(mapLegacySource('rule')).toBe('rule')
    expect(mapLegacySource('default')).toBe('default')
    expect(mapLegacySource('not_found')).toBe('not_found')
    expect(mapLegacySource('disabled')).toBe('disabled')
  })

  it('maps the holdout and bandit terminal sources', () => {
    expect(mapLegacySource('holdout')).toBe('holdout')
    expect(mapLegacySource('bandit')).toBe('bandit')
  })

  it('is idempotent on values that are already public', () => {
    // SDK layers cast into this function; before the passthrough existed
    // an already-public value fell off the end of the switch and produced
    // undefined, i.e. a flag with no source at all.
    expect(mapLegacySource('datafileOverride')).toBe('datafileOverride')
    expect(mapLegacySource('runtimeOverride')).toBe('runtimeOverride')
    expect(mapLegacySource('not_ready')).toBe('not_ready')
  })
})
