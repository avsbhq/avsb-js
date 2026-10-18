import { describe, it, expect, vi } from 'vitest'
import { evaluateHoldout } from './holdouts'
import { evaluateFlag } from './evaluate'
import { holdoutBucket } from './engine'
import type {
  EvalContext,
  ExposureEvent,
  FlagDatafile,
  FlagDatafileEntry,
  FlagDatafileHoldout,
  MultiContext,
  SingleContext,
} from './types'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeFlag(overrides: Partial<FlagDatafileEntry> = {}): FlagDatafileEntry {
  return {
    id: 'flag-1',
    key: 'my-flag',
    type: 'boolean',
    enabled: true,
    defaultVariationId: 'var-off',
    variations: [
      { id: 'var-off', key: 'off', value: false },
      { id: 'var-on', key: 'on', value: true },
    ],
    overrides: [],
    rules: [],
    ...overrides,
  }
}

function makeHoldout(
  overrides: Partial<FlagDatafileHoldout> = {}
): FlagDatafileHoldout {
  return {
    id: 'ho-1',
    key: 'main-holdout',
    trafficAllocation: 0.5,
    flagIds: ['flag-1'],
    hashAttribute: 'user.key',
    defaultVariationByFlag: { 'flag-1': 'var-off' },
    ...overrides,
  }
}

function makeDatafile(
  flags: FlagDatafileEntry[],
  holdouts?: FlagDatafileHoldout[]
): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: 'sdk-key',
    environmentKey: 'test',
    publishedAt: '2026-01-01T00:00:00.000Z',
    collectEndpoint: 'https://collect.example.com',
    flags,
    audiences: [],
    ...(holdouts ? { holdouts } : {}),
  }
}

function userCtx(key: string, attributes: Record<string, unknown> = {}): SingleContext {
  return { kind: 'user', key, ...attributes }
}

// ---------------------------------------------------------------------------
// 1. flag not participating in any holdout
// ---------------------------------------------------------------------------

describe('evaluateHoldout — flag not in holdout list', () => {
  it('returns heldOut=false when flagId is absent from every holdout', () => {
    const ctx = userCtx('u-1')
    const holdout = makeHoldout({ flagIds: ['other-flag'] })
    const datafile = makeDatafile([makeFlag()], [holdout])
    const result = evaluateHoldout(ctx, 'flag-1', datafile)
    expect(result.heldOut).toBe(false)
    expect(result.holdout).toBeUndefined()
  })

  it('returns heldOut=false when datafile has no holdouts at all', () => {
    const ctx = userCtx('u-1')
    const datafile = makeDatafile([makeFlag()])
    const result = evaluateHoldout(ctx, 'flag-1', datafile)
    expect(result.heldOut).toBe(false)
  })

  it('returns heldOut=false when holdouts array is empty', () => {
    const ctx = userCtx('u-1')
    const datafile = makeDatafile([makeFlag()], [])
    const result = evaluateHoldout(ctx, 'flag-1', datafile)
    expect(result.heldOut).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. traffic-allocation bounds
// ---------------------------------------------------------------------------

describe('evaluateHoldout — traffic allocation bounds', () => {
  it('never holds out when trafficAllocation is 0.0', () => {
    const holdout = makeHoldout({ trafficAllocation: 0 })
    const datafile = makeDatafile([makeFlag()], [holdout])
    for (const key of ['u-1', 'u-2', 'u-3', 'u-anyone']) {
      const result = evaluateHoldout(userCtx(key), 'flag-1', datafile)
      expect(result.heldOut).toBe(false)
    }
  })

  it('always holds out when trafficAllocation is 1.0', () => {
    const holdout = makeHoldout({ trafficAllocation: 1 })
    const datafile = makeDatafile([makeFlag()], [holdout])
    for (const key of ['u-1', 'u-2', 'u-3', 'u-anyone']) {
      const result = evaluateHoldout(userCtx(key), 'flag-1', datafile)
      expect(result.heldOut).toBe(true)
      expect(result.holdout?.id).toBe('ho-1')
    }
  })

  it('produces deterministic bucketing at 0.5 traffic (same key → same outcome)', () => {
    const holdout = makeHoldout({ trafficAllocation: 0.5 })
    const datafile = makeDatafile([makeFlag()], [holdout])
    const a = evaluateHoldout(userCtx('u-stable'), 'flag-1', datafile)
    const b = evaluateHoldout(userCtx('u-stable'), 'flag-1', datafile)
    expect(a.heldOut).toBe(b.heldOut)
  })

  it('splits roughly half of a population at 0.5 traffic', () => {
    const holdout = makeHoldout({ trafficAllocation: 0.5 })
    const datafile = makeDatafile([makeFlag()], [holdout])
    let heldOut = 0
    const N = 200
    for (let i = 0; i < N; i++) {
      const r = evaluateHoldout(userCtx(`u-${i}`), 'flag-1', datafile)
      if (r.heldOut) heldOut++
    }
    // Expect ~50% with tolerance — 200 samples gives a comfortable window.
    expect(heldOut).toBeGreaterThan(N * 0.3)
    expect(heldOut).toBeLessThan(N * 0.7)
  })

  // Spec §1.4: threshold math is a float comparison against the raw
  // product, identical to the ab_test allocation check. This function used
  // to floor the threshold, which put the two checks one bucket out of
  // step with each other.
  //
  // 0.12345 puts the threshold at 1234.5, half a bucket away from any
  // integer: bucket 1234 is inside the window under the float comparison
  // and outside it under the floored one. The half-bucket gap is what
  // makes the assertion immune to floating-point dust.
  it('compares the bucket against the raw float threshold, not a floored one', () => {
    const holdout = makeHoldout({ trafficAllocation: 0.12345 })
    const datafile = makeDatafile([makeFlag()], [holdout])

    let boundaryKey: string | null = null
    for (let i = 0; i < 200_000 && boundaryKey === null; i++) {
      const candidate = `holdout-probe-${i}`
      if (holdoutBucket('main-holdout', candidate) === 1234) {
        boundaryKey = candidate
      }
    }
    expect(boundaryKey, 'no key hashed to holdout bucket 1234').not.toBeNull()

    const onBoundary = evaluateHoldout(
      userCtx(boundaryKey as string),
      'flag-1',
      datafile
    )
    expect(onBoundary.heldOut).toBe(true)

    // And the next bucket up is outside, so the assertion above is not
    // just "everything is held out".
    let outsideKey: string | null = null
    for (let i = 0; i < 200_000 && outsideKey === null; i++) {
      const candidate = `holdout-probe-out-${i}`
      if (holdoutBucket('main-holdout', candidate) === 1235) {
        outsideKey = candidate
      }
    }
    expect(outsideKey, 'no key hashed to holdout bucket 1235').not.toBeNull()
    expect(
      evaluateHoldout(userCtx(outsideKey as string), 'flag-1', datafile).heldOut
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. holdout-served variation = defaultVariationByFlag[flagId]
// ---------------------------------------------------------------------------

describe('evaluateHoldout — variation served', () => {
  it('returns the variationId declared in defaultVariationByFlag[flagId]', () => {
    const holdout = makeHoldout({
      trafficAllocation: 1,
      defaultVariationByFlag: { 'flag-1': 'var-off', 'flag-2': 'var-on' },
    })
    const datafile = makeDatafile([makeFlag()], [holdout])
    const result = evaluateHoldout(userCtx('u-1'), 'flag-1', datafile)
    expect(result.heldOut).toBe(true)
    expect(result.variationId).toBe('var-off')
  })

  it('omits variationId when the flag has no entry in defaultVariationByFlag', () => {
    const holdout = makeHoldout({
      trafficAllocation: 1,
      defaultVariationByFlag: {},
    })
    const datafile = makeDatafile([makeFlag()], [holdout])
    const result = evaluateHoldout(userCtx('u-1'), 'flag-1', datafile)
    expect(result.heldOut).toBe(true)
    expect(result.variationId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. End-to-end evaluator integration — exposure event + source
// ---------------------------------------------------------------------------

describe('evaluateFlag — holdout integration', () => {
  it('emits exposure with ruleType=holdout and properties.holdoutId set', () => {
    const flag = makeFlag({
      id: 'flag-1',
      defaultVariationId: 'var-off',
      rules: [
        {
          id: 'rule-ab',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'user.key',
          trafficAllocation: 1,
          variations: [
            { variationId: 'var-on', percentage: 1 },
            { variationId: 'var-off', percentage: 0 },
          ],
        },
      ],
    })
    const holdout = makeHoldout({ trafficAllocation: 1 })
    const datafile = makeDatafile([flag], [holdout])
    const onExposure = vi.fn<(event: ExposureEvent) => void>()
    const result = evaluateFlag(
      'my-flag',
      null,
      userCtx('u-1'),
      datafile,
      onExposure
    )
    expect(result.source).toBe('holdout')
    expect(result.ruleType).toBe('holdout')
    expect(onExposure).toHaveBeenCalledTimes(1)
    const evt = onExposure.mock.calls[0][0]
    expect(evt.eventName).toBe('flag_holdout_exposure')
    expect(evt.properties).toMatchObject({
      flagKey: 'my-flag',
      flagId: 'flag-1',
      holdoutId: 'ho-1',
    })
  })

  it('falls back to the flag defaultVariationId when defaultVariationByFlag omits it', () => {
    const flag = makeFlag({
      id: 'flag-1',
      defaultVariationId: 'var-on',
    })
    const holdout = makeHoldout({
      trafficAllocation: 1,
      defaultVariationByFlag: {},
    })
    const datafile = makeDatafile([flag], [holdout])
    const result = evaluateFlag(
      'my-flag',
      null,
      userCtx('u-1'),
      datafile
    )
    expect(result.source).toBe('holdout')
    expect(result.variationKey).toBe('on')
    expect(result.value).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. Mutual exclusion — shared holdout, two flags, same context
// ---------------------------------------------------------------------------

describe('evaluateHoldout — mutual exclusion across flags', () => {
  it('two flags sharing one holdout classify the same context identically', () => {
    const sharedHoldout = makeHoldout({
      trafficAllocation: 0.5,
      flagIds: ['flag-1', 'flag-2'],
      defaultVariationByFlag: {
        'flag-1': 'var-off',
        'flag-2': 'var-off',
      },
    })
    const datafile = makeDatafile([], [sharedHoldout])
    // Walk a population; every user must get the SAME heldOut answer
    // for both flags (mutual exclusion guarantee).
    for (let i = 0; i < 100; i++) {
      const ctx = userCtx(`u-${i}`)
      const r1 = evaluateHoldout(ctx, 'flag-1', datafile)
      const r2 = evaluateHoldout(ctx, 'flag-2', datafile)
      expect(r1.heldOut).toBe(r2.heldOut)
    }
  })

  it('different holdouts on the same context can disagree (no cross-pollination)', () => {
    // Two holdouts with different keys → independent bucketing — we just
    // assert that at least one context lands differently across them
    // somewhere in the sample.
    const datafile: FlagDatafile = {
      version: 2,
      projectType: 'FEATURE_FLAG',
      sdkKey: 'sdk',
      environmentKey: 'test',
      publishedAt: '2026-01-01T00:00:00.000Z',
      collectEndpoint: 'https://collect.example.com',
      flags: [],
      audiences: [],
      holdouts: [
        makeHoldout({
          id: 'ho-a',
          key: 'alpha',
          trafficAllocation: 0.5,
          flagIds: ['flag-1'],
        }),
        makeHoldout({
          id: 'ho-b',
          key: 'beta',
          trafficAllocation: 0.5,
          flagIds: ['flag-2'],
        }),
      ],
    }
    let disagreements = 0
    for (let i = 0; i < 100; i++) {
      const ctx = userCtx(`u-${i}`)
      const r1 = evaluateHoldout(ctx, 'flag-1', datafile)
      const r2 = evaluateHoldout(ctx, 'flag-2', datafile)
      if (r1.heldOut !== r2.heldOut) disagreements++
    }
    // Different keys → uncorrelated buckets; we expect many disagreements.
    expect(disagreements).toBeGreaterThan(10)
  })
})

// ---------------------------------------------------------------------------
// 6. hashAttribute paths — multi-context bucketing
// ---------------------------------------------------------------------------

describe('evaluateHoldout — hashAttribute paths', () => {
  it('honours hashAttribute="user.key" by bucketing on the user sub-context', () => {
    const holdout = makeHoldout({
      trafficAllocation: 0.5,
      hashAttribute: 'user.key',
    })
    const datafile = makeDatafile([], [holdout])
    // Same user paired with different orgs → same heldOut outcome.
    const ctx1: MultiContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'u-shared' },
      organization: { kind: 'organization', key: 'org-a' },
    }
    const ctx2: MultiContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'u-shared' },
      organization: { kind: 'organization', key: 'org-b' },
    }
    expect(evaluateHoldout(ctx1, 'flag-1', datafile).heldOut).toBe(
      evaluateHoldout(ctx2, 'flag-1', datafile).heldOut
    )
  })

  it('honours hashAttribute="organization.key" — different orgs may diverge', () => {
    const holdout = makeHoldout({
      trafficAllocation: 0.5,
      hashAttribute: 'organization.key',
    })
    const datafile = makeDatafile([], [holdout])
    // Same user across many different orgs — we should see divergent
    // heldOut outcomes somewhere in the sample (org keys drive bucketing).
    let trueCount = 0
    let falseCount = 0
    for (let i = 0; i < 100; i++) {
      const ctx: MultiContext = {
        kind: 'multi',
        user: { kind: 'user', key: 'u-shared' },
        organization: { kind: 'organization', key: `org-${i}` },
      }
      if (evaluateHoldout(ctx, 'flag-1', datafile).heldOut) trueCount++
      else falseCount++
    }
    expect(trueCount).toBeGreaterThan(0)
    expect(falseCount).toBeGreaterThan(0)
  })

  it('missing context kind for hashAttribute resolves to empty key and stays deterministic', () => {
    const holdout = makeHoldout({
      trafficAllocation: 0.5,
      hashAttribute: 'organization.key',
    })
    const datafile = makeDatafile([], [holdout])
    // The user has no organization sub-context — the bucket key collapses
    // to '' and EVERY such context lands in the same bucket.
    const ctx: EvalContext = { kind: 'user', key: 'u-1' }
    const a = evaluateHoldout(ctx, 'flag-1', datafile)
    const b = evaluateHoldout(ctx, 'flag-1', datafile)
    expect(a.heldOut).toBe(b.heldOut)
    // The classification is the same for any other user with a missing
    // organization sub-context (deterministic empty-key bucket).
    const otherCtx: EvalContext = { kind: 'user', key: 'u-99' }
    expect(evaluateHoldout(otherCtx, 'flag-1', datafile).heldOut).toBe(a.heldOut)
  })
})
