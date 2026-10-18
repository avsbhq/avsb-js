import { describe, it, expect } from 'vitest'
import {
  evaluateBandit,
  epsilonGreedy,
  thompsonSample,
  ucb1,
  seededGaussian,
  createInMemoryBanditModelStore,
  type BanditModel,
  type BanditPerActionStats,
} from './bandits'
import type { BanditAction, BanditConfig, EvalContext } from './types'

// ---------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------

function makeActions(ids: string[]): BanditAction[] {
  return ids.map((id) => ({ id, variationId: `var-${id}` }))
}

function makeStats(
  entries: Record<string, Partial<BanditPerActionStats>>
): Record<string, BanditPerActionStats> {
  const out: Record<string, BanditPerActionStats> = {}
  for (const [k, v] of Object.entries(entries)) {
    out[k] = {
      mean: v.mean ?? 0,
      variance: v.variance ?? 1,
      samples: v.samples ?? 0,
    }
  }
  return out
}

function userCtx(key: string, attrs: Record<string, unknown> = {}): EvalContext {
  return { kind: 'user', key, ...attrs }
}

const BASE_CONFIG: BanditConfig = {
  algorithm: 'epsilon-greedy',
  rewardMetric: 'reward',
  explorationRate: 0.1,
  actions: makeActions(['a', 'b', 'c']),
}

// =====================================================================
// seededGaussian.
// =====================================================================

describe('seededGaussian', () => {
  it('produces a deterministic output for a given seed', () => {
    const a = seededGaussian(42)
    const b = seededGaussian(42)
    expect(a).toBe(b)
  })

  it('produces different outputs for different seeds', () => {
    const a = seededGaussian(1)
    const b = seededGaussian(2)
    expect(a).not.toBe(b)
  })

  it('returns finite numbers across many seeds', () => {
    for (let i = 0; i < 1000; i++) {
      const v = seededGaussian(i)
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('approximates a unit-variance distribution over many seeds', () => {
    const n = 5000
    let sum = 0
    let sumSq = 0
    for (let i = 0; i < n; i++) {
      const z = seededGaussian(i * 1009 + 17)
      sum += z
      sumSq += z * z
    }
    const mean = sum / n
    const variance = sumSq / n - mean * mean
    expect(Math.abs(mean)).toBeLessThan(0.1)
    expect(Math.abs(variance - 1)).toBeLessThan(0.2)
  })
})

// =====================================================================
// epsilonGreedy.
// =====================================================================

describe('epsilonGreedy', () => {
  const stats = makeStats({
    a: { mean: 0.1, samples: 10 },
    b: { mean: 0.9, samples: 10 },
    c: { mean: 0.5, samples: 10 },
  })

  it('exploits the highest-mean action when the bucket is above epsilon', () => {
    const result = epsilonGreedy(stats, BASE_CONFIG.actions, 5000, 0.1)
    expect(result.action.id).toBe('b')
    expect(result.exploreFired).toBe(false)
  })

  it('fires the explore branch when bucket fraction is below epsilon', () => {
    const result = epsilonGreedy(stats, BASE_CONFIG.actions, 500, 0.1)
    // 500/10000 = 0.05 < 0.1 → explore
    expect(result.exploreFired).toBe(true)
  })

  it('is deterministic given identical inputs', () => {
    const r1 = epsilonGreedy(stats, BASE_CONFIG.actions, 7777, 0.1)
    const r2 = epsilonGreedy(stats, BASE_CONFIG.actions, 7777, 0.1)
    expect(r1.action.id).toBe(r2.action.id)
    expect(r1.actionProbability).toBe(r2.actionProbability)
  })

  it('handles single-action edge case by returning that action', () => {
    const single = makeActions(['only'])
    const result = epsilonGreedy(
      makeStats({ only: { mean: 0, samples: 0 } }),
      single,
      5000,
      0.1
    )
    expect(result.action.id).toBe('only')
  })

  it('breaks all-zero-mean ties alphabetically on action id', () => {
    const zero = makeStats({
      a: { mean: 0, samples: 5 },
      b: { mean: 0, samples: 5 },
      c: { mean: 0, samples: 5 },
    })
    const result = epsilonGreedy(zero, BASE_CONFIG.actions, 9000, 0.1)
    expect(result.exploreFired).toBe(false)
    expect(result.action.id).toBe('a')
  })

  it('uses default epsilon=0.1 when explorationRate is undefined', () => {
    const r1 = epsilonGreedy(stats, BASE_CONFIG.actions, 5000, undefined)
    const r2 = epsilonGreedy(stats, BASE_CONFIG.actions, 5000, 0.1)
    expect(r1.action.id).toBe(r2.action.id)
    expect(r1.actionProbability).toBe(r2.actionProbability)
  })

  it('reports actionProbability = epsilon/N on the explore branch', () => {
    const result = epsilonGreedy(stats, BASE_CONFIG.actions, 100, 0.1)
    expect(result.exploreFired).toBe(true)
    expect(result.actionProbability).toBeCloseTo(0.1 / 3, 10)
  })

  it('reports actionProbability = (1-eps)/k + eps/N on exploit with tied winners', () => {
    const tied = makeStats({
      a: { mean: 0.5, samples: 5 },
      b: { mean: 0.5, samples: 5 },
      c: { mean: 0.1, samples: 5 },
    })
    const result = epsilonGreedy(tied, BASE_CONFIG.actions, 5000, 0.1)
    expect(result.exploreFired).toBe(false)
    // 2 winners tied → (1-0.1)/2 + 0.1/3 = 0.45 + 0.0333... = 0.4833...
    expect(result.actionProbability).toBeCloseTo(0.45 + 0.1 / 3, 10)
  })

  it('throws when called with an empty action list', () => {
    expect(() => epsilonGreedy({}, [], 0, 0.1)).toThrow()
  })
})

// =====================================================================
// thompsonSample.
// =====================================================================

describe('thompsonSample', () => {
  const stats = makeStats({
    a: { mean: 0.1, variance: 0.05, samples: 20 },
    b: { mean: 0.9, variance: 0.05, samples: 20 },
    c: { mean: 0.5, variance: 0.05, samples: 20 },
  })

  it('is deterministic for a given hashBucket + model', () => {
    const r1 = thompsonSample(stats, BASE_CONFIG.actions, 12345)
    const r2 = thompsonSample(stats, BASE_CONFIG.actions, 12345)
    expect(r1.action.id).toBe(r2.action.id)
  })

  it('produces different decisions across many hashBuckets', () => {
    // Wide variance + few samples → the draws overlap across actions,
    // so every action should be selected at least once across many buckets.
    const wide = makeStats({
      a: { mean: 0.1, variance: 1, samples: 1 },
      b: { mean: 0.5, variance: 1, samples: 1 },
      c: { mean: 0.9, variance: 1, samples: 1 },
    })
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      seen.add(thompsonSample(wide, BASE_CONFIG.actions, i).action.id)
    }
    expect(seen.size).toBe(3)
  })

  it('prefers the highest-mean action on average when variance is tight', () => {
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 }
    const tightStats = makeStats({
      a: { mean: 0.1, variance: 0.001, samples: 100 },
      b: { mean: 0.9, variance: 0.001, samples: 100 },
      c: { mean: 0.5, variance: 0.001, samples: 100 },
    })
    for (let i = 0; i < 500; i++) {
      const r = thompsonSample(tightStats, BASE_CONFIG.actions, i)
      counts[r.action.id] = (counts[r.action.id] ?? 0) + 1
    }
    expect(counts.b).toBeGreaterThan(counts.a)
    expect(counts.b).toBeGreaterThan(counts.c)
  })

  it('handles single-action edge case', () => {
    const single = makeActions(['only'])
    const result = thompsonSample(
      makeStats({ only: { mean: 0, samples: 0 } }),
      single,
      42
    )
    expect(result.action.id).toBe('only')
    expect(result.actionProbability).toBe(1)
  })

  it('handles all-zero-mean cold start without crashing', () => {
    const zero = makeStats({
      a: { mean: 0, samples: 0 },
      b: { mean: 0, samples: 0 },
      c: { mean: 0, samples: 0 },
    })
    const result = thompsonSample(zero, BASE_CONFIG.actions, 9999)
    expect(['a', 'b', 'c']).toContain(result.action.id)
  })

  it('reports actionProbability = 1/N as a documented placeholder', () => {
    const result = thompsonSample(stats, BASE_CONFIG.actions, 1)
    expect(result.actionProbability).toBeCloseTo(1 / 3, 10)
  })

  it('throws on empty action list', () => {
    expect(() => thompsonSample({}, [], 0)).toThrow()
  })
})

// =====================================================================
// ucb1.
// =====================================================================

describe('ucb1', () => {
  it('returns the first zero-sample action during cold start', () => {
    const stats = makeStats({
      a: { samples: 0 },
      b: { samples: 5, mean: 0.5 },
      c: { samples: 5, mean: 0.3 },
    })
    const result = ucb1(stats, BASE_CONFIG.actions)
    expect(result.action.id).toBe('a')
    expect(result.actionProbability).toBe(1)
  })

  it('breaks cold-start ties alphabetically', () => {
    const stats = makeStats({
      a: { samples: 0 },
      b: { samples: 0 },
      c: { samples: 0 },
    })
    const result = ucb1(stats, BASE_CONFIG.actions)
    expect(result.action.id).toBe('a')
  })

  it('selects the action with the highest UCB score once warm', () => {
    const stats = makeStats({
      a: { mean: 0.1, samples: 50 },
      b: { mean: 0.9, samples: 50 },
      c: { mean: 0.5, samples: 50 },
    })
    const result = ucb1(stats, BASE_CONFIG.actions)
    expect(result.action.id).toBe('b')
  })

  it('is deterministic for a given model', () => {
    const stats = makeStats({
      a: { mean: 0.4, samples: 10 },
      b: { mean: 0.6, samples: 10 },
      c: { mean: 0.5, samples: 10 },
    })
    const r1 = ucb1(stats, BASE_CONFIG.actions)
    const r2 = ucb1(stats, BASE_CONFIG.actions)
    expect(r1.action.id).toBe(r2.action.id)
  })

  it('prefers under-sampled actions even with lower means via the exploration bonus', () => {
    const stats = makeStats({
      a: { mean: 0.55, samples: 100 },
      b: { mean: 0.5, samples: 2 },
    })
    const result = ucb1(stats, makeActions(['a', 'b']))
    // sqrt(2*ln(102)/2) ≈ sqrt(4.625) ≈ 2.15 → b dominates.
    expect(result.action.id).toBe('b')
  })

  it('handles single-action edge case', () => {
    const single = makeActions(['only'])
    const result = ucb1(makeStats({ only: { samples: 5, mean: 0.3 } }), single)
    expect(result.action.id).toBe('only')
  })

  it('handles all-zero-mean already-sampled cohort by alphabetical tie-break', () => {
    const stats = makeStats({
      a: { mean: 0, samples: 5 },
      b: { mean: 0, samples: 5 },
      c: { mean: 0, samples: 5 },
    })
    const result = ucb1(stats, BASE_CONFIG.actions)
    expect(result.action.id).toBe('a')
  })

  it('reports actionProbability = 1.0 (UCB1 is deterministic)', () => {
    const stats = makeStats({
      a: { mean: 0.1, samples: 10 },
      b: { mean: 0.9, samples: 10 },
      c: { mean: 0.5, samples: 10 },
    })
    expect(ucb1(stats, BASE_CONFIG.actions).actionProbability).toBe(1)
  })

  it('throws on empty action list', () => {
    expect(() => ucb1({}, [])).toThrow()
  })
})

// =====================================================================
// evaluateBandit (top-level integration).
// =====================================================================

describe('evaluateBandit', () => {
  it('returns null when the store has no model for the key', () => {
    const store = createInMemoryBanditModelStore()
    const result = evaluateBandit(
      'cta-test',
      BASE_CONFIG,
      userCtx('u-1'),
      store
    )
    expect(result).toBeNull()
  })

  it('returns a BanditDecisionLogEntry with the required wire shape', () => {
    const model: BanditModel = {
      version: 'v-2026-05-28',
      algorithm: 'epsilon-greedy',
      perAction: makeStats({
        a: { mean: 0.1, samples: 10 },
        b: { mean: 0.9, samples: 10 },
        c: { mean: 0.5, samples: 10 },
      }),
    }
    const store = createInMemoryBanditModelStore({ 'cta-test': model })
    const result = evaluateBandit(
      'cta-test',
      BASE_CONFIG,
      userCtx('user-7'),
      store
    )
    expect(result).not.toBeNull()
    if (!result) return

    const { action, banditEntry } = result
    expect(typeof action.id).toBe('string')
    expect(banditEntry.banditKey).toBe('cta-test')
    expect(banditEntry.actionId).toBe(action.id)
    expect(banditEntry.modelVersion).toBe('v-2026-05-28')
    expect(typeof banditEntry.actionProbability).toBe('number')
    expect(banditEntry.source).toBe('bandit')
    expect(banditEntry.ruleType).toBe('bandit')
    expect(banditEntry.evaluatedAt).toBeGreaterThan(0)
    expect(banditEntry.durationMicros).toBeGreaterThanOrEqual(0)
    expect(banditEntry.contextSummary).toEqual([
      { kind: 'user', key: 'user-7' },
    ])
  })

  it('reports optimalityGap = explorationRate when explore branch fires', () => {
    const model: BanditModel = {
      version: 'v1',
      algorithm: 'epsilon-greedy',
      perAction: makeStats({
        a: { mean: 0.1, samples: 5 },
        b: { mean: 0.9, samples: 5 },
      }),
    }
    const store = createInMemoryBanditModelStore({ 'k': model })
    // Try many context keys until we find one whose hash bucket explores.
    let explored = false
    for (let i = 0; i < 1000; i++) {
      const r = evaluateBandit(
        'k',
        {
          algorithm: 'epsilon-greedy',
          rewardMetric: 'r',
          explorationRate: 0.5,
          actions: makeActions(['a', 'b']),
        },
        userCtx(`u-${i}`),
        store
      )
      if (!r) continue
      if (r.banditEntry.optimalityGap !== null) {
        expect(r.banditEntry.optimalityGap).toBe(0.5)
        explored = true
        break
      }
    }
    expect(explored).toBe(true)
  })

  it('reports optimalityGap = null for Thompson sampling', () => {
    const model: BanditModel = {
      version: 'v1',
      algorithm: 'thompson-sampling',
      perAction: makeStats({
        a: { mean: 0.3, variance: 0.1, samples: 10 },
        b: { mean: 0.7, variance: 0.1, samples: 10 },
      }),
    }
    const store = createInMemoryBanditModelStore({ k: model })
    const result = evaluateBandit(
      'k',
      {
        algorithm: 'thompson-sampling',
        rewardMetric: 'r',
        actions: makeActions(['a', 'b']),
      },
      userCtx('u-1'),
      store
    )
    expect(result?.banditEntry.optimalityGap).toBeNull()
  })

  it('reports optimalityGap = null for UCB1', () => {
    const model: BanditModel = {
      version: 'v1',
      algorithm: 'ucb1',
      perAction: makeStats({
        a: { mean: 0.3, samples: 10 },
        b: { mean: 0.7, samples: 10 },
      }),
    }
    const store = createInMemoryBanditModelStore({ k: model })
    const result = evaluateBandit(
      'k',
      {
        algorithm: 'ucb1',
        rewardMetric: 'r',
        actions: makeActions(['a', 'b']),
      },
      userCtx('u-1'),
      store
    )
    expect(result?.banditEntry.optimalityGap).toBeNull()
  })

  it('produces the same action for the same context + same model (replay)', () => {
    const model: BanditModel = {
      version: 'v1',
      algorithm: 'ucb1',
      perAction: makeStats({
        a: { mean: 0.1, samples: 50 },
        b: { mean: 0.9, samples: 50 },
        c: { mean: 0.5, samples: 50 },
      }),
    }
    const store = createInMemoryBanditModelStore({ k: model })
    const r1 = evaluateBandit(
      'k',
      { ...BASE_CONFIG, algorithm: 'ucb1' },
      userCtx('user-99'),
      store
    )
    const r2 = evaluateBandit(
      'k',
      { ...BASE_CONFIG, algorithm: 'ucb1' },
      userCtx('user-99'),
      store
    )
    expect(r1?.action.id).toBe(r2?.action.id)
    expect(r1?.banditEntry.actionId).toBe(r2?.banditEntry.actionId)
  })

  it('uses contextualModels lookup when the bucket key is present', () => {
    const configWithCtx: BanditConfig = {
      algorithm: 'epsilon-greedy',
      rewardMetric: 'reward',
      explorationRate: 0,
      actions: [
        { id: 'a', variationId: 'va', contextAttributes: { tier: 'free' } },
        { id: 'b', variationId: 'vb', contextAttributes: { tier: 'free' } },
      ],
    }
    const model: BanditModel = {
      version: 'v1',
      algorithm: 'epsilon-greedy',
      perAction: makeStats({
        a: { mean: 0.9, samples: 10 },
        b: { mean: 0.1, samples: 10 },
      }),
      contextualModels: {
        'tier=pro': makeStats({
          // Pro users prefer 'b' — the opposite of the top-level model.
          a: { mean: 0.1, samples: 10 },
          b: { mean: 0.9, samples: 10 },
        }),
      },
    }
    const store = createInMemoryBanditModelStore({ k: model })
    const proResult = evaluateBandit(
      'k',
      configWithCtx,
      userCtx('u-1', { tier: 'pro' }),
      store
    )
    expect(proResult?.action.id).toBe('b')
  })

  it('falls back to the top-level perAction map when bucket is not in contextualModels', () => {
    const configWithCtx: BanditConfig = {
      algorithm: 'epsilon-greedy',
      rewardMetric: 'reward',
      explorationRate: 0,
      actions: [
        { id: 'a', variationId: 'va', contextAttributes: { tier: 'free' } },
        { id: 'b', variationId: 'vb', contextAttributes: { tier: 'free' } },
      ],
    }
    const model: BanditModel = {
      version: 'v1',
      algorithm: 'epsilon-greedy',
      perAction: makeStats({
        a: { mean: 0.9, samples: 10 },
        b: { mean: 0.1, samples: 10 },
      }),
      contextualModels: {
        'tier=pro': makeStats({
          a: { mean: 0.1, samples: 10 },
          b: { mean: 0.9, samples: 10 },
        }),
      },
    }
    const store = createInMemoryBanditModelStore({ k: model })
    const enterpriseResult = evaluateBandit(
      'k',
      configWithCtx,
      userCtx('u-1', { tier: 'enterprise' }),
      store
    )
    // Falls through to top-level → 'a' wins (mean 0.9 > 0.1).
    expect(enterpriseResult?.action.id).toBe('a')
  })

  it('records exactly one contextSummary entry per sub-context', () => {
    const model: BanditModel = {
      version: 'v1',
      algorithm: 'ucb1',
      perAction: makeStats({ a: { mean: 0.5, samples: 5 } }),
    }
    const store = createInMemoryBanditModelStore({ k: model })
    const ctx: EvalContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'u-1' },
      organization: { kind: 'organization', key: 'org-7' },
    }
    const result = evaluateBandit(
      'k',
      {
        algorithm: 'ucb1',
        rewardMetric: 'r',
        actions: makeActions(['a']),
      },
      ctx,
      store
    )
    expect(result?.banditEntry.contextSummary).toEqual([
      { kind: 'user', key: 'u-1' },
      { kind: 'organization', key: 'org-7' },
    ])
  })
})

// =====================================================================
// createInMemoryBanditModelStore.
// =====================================================================

describe('createInMemoryBanditModelStore', () => {
  it('returns null for an unknown bandit key', () => {
    const store = createInMemoryBanditModelStore()
    expect(store.getModel('nope')).toBeNull()
  })

  it('persists models written via updateModel', () => {
    const store = createInMemoryBanditModelStore()
    const model: BanditModel = {
      version: 'v1',
      algorithm: 'epsilon-greedy',
      perAction: makeStats({ a: { mean: 0.1, samples: 1 } }),
    }
    store.updateModel('k', model)
    expect(store.getModel('k')).toBe(model)
  })

  it('seeds from the initial map', () => {
    const seeded: BanditModel = {
      version: 'seeded',
      algorithm: 'ucb1',
      perAction: {},
    }
    const store = createInMemoryBanditModelStore({ k: seeded })
    expect(store.getModel('k')).toBe(seeded)
  })

  it('overwrites an existing model on updateModel', () => {
    const initial: BanditModel = {
      version: 'old',
      algorithm: 'ucb1',
      perAction: {},
    }
    const next: BanditModel = {
      version: 'new',
      algorithm: 'ucb1',
      perAction: {},
    }
    const store = createInMemoryBanditModelStore({ k: initial })
    store.updateModel('k', next)
    expect(store.getModel('k')).toBe(next)
  })
})
