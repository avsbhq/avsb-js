// =====================================================================
// Bandit evaluation engine — epsilon-greedy, Thompson sampling, UCB1.
//
// Spec reference: _specs/sdk-launch-readiness-spec.md §2.10 (wire shapes)
// and §8.6 (workstream definition).
//
// Design invariants (do not regress):
//   - Algorithms are pure functions of `(perAction, actions, hashBucket?)`.
//   - No `Math.random()` — every stochastic step is seeded from murmurhash3
//     so a `(banditKey, context)` pair produces a stable decision. This is
//     what lets us write unit tests with concrete expected actions and
//     replay decisions during incident triage.
//   - Tie-breaking is alphabetical on action id, also for determinism.
// =====================================================================

import type {
  BanditAction,
  BanditConfig,
  BanditDecisionLogEntry,
  EvalContext,
} from './types'
import { bucketingKey, contextSummary } from './context'
import { murmurhash3 } from './hash'

// ---------------------------------------------------------------------
// Public model + store shapes.
// ---------------------------------------------------------------------

export interface BanditPerActionStats {
  mean: number
  variance: number
  samples: number
}

export interface BanditModel {
  version: string
  algorithm: 'epsilon-greedy' | 'thompson-sampling' | 'ucb1'
  perAction: Record<string, BanditPerActionStats>
  /**
   * Optional per-context-bucket override maps. Bucket keys are produced by
   * joining the configured `BanditAction.contextAttributes` as
   * `key=value;key=value` (keys alphabetically sorted). When present and
   * the request's bucket matches, the per-bucket map replaces `perAction`.
   */
  contextualModels?: Record<string, Record<string, BanditPerActionStats>>
}

export interface BanditModelStore {
  /** Synchronous hot-path read. */
  getModel(banditKey: string): BanditModel | null
  /** Fire-and-forget: implementations are free to batch/persist async. */
  updateModel(banditKey: string, model: BanditModel): void
}

// ---------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------

const MAX_BUCKET = 10000

/** Sort actions in-place to a stable order (alphabetical by id). */
function sortedActions(actions: BanditAction[]): BanditAction[] {
  return [...actions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function statsFor(
  perAction: Record<string, BanditPerActionStats>,
  actionId: string
): BanditPerActionStats {
  const existing = perAction[actionId]
  if (existing) return existing
  // Default cold-start stats — zero mean, zero samples. Variance defaults
  // to 1 so Thompson sampling still has a defined scale on unseen actions.
  return { mean: 0, variance: 1, samples: 0 }
}

/**
 * Derive a "context bucket" string for contextual model lookup.
 *
 * Concatenates the configured `BanditAction.contextAttributes` keys (sorted
 * alphabetically) with their concrete values from the request context. The
 * resulting string is the key into `BanditModel.contextualModels`.
 *
 * Returns an empty string when no contextAttributes are declared on any
 * action — callers treat that as "no contextual lookup, use top-level".
 */
function deriveContextBucket(
  config: BanditConfig,
  context: EvalContext
): string {
  const keys = new Set<string>()
  for (const action of config.actions) {
    if (!action.contextAttributes) continue
    for (const key of Object.keys(action.contextAttributes)) keys.add(key)
  }
  if (keys.size === 0) return ''

  const sorted = Array.from(keys).sort()
  const parts: string[] = []
  for (const key of sorted) {
    const value = resolveContextAttribute(context, key)
    parts.push(`${key}=${value}`)
  }
  return parts.join(';')
}

/**
 * Pull an attribute off the context for contextual-bucket lookup. Walks
 * a dotted path so `organization.tier` resolves against the matching
 * sub-context in a multi-context container.
 */
function resolveContextAttribute(ctx: EvalContext, key: string): string {
  const path = key.split('.')
  let cursor: unknown = ctx
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return ''
    const record = cursor as Record<string, unknown>
    cursor = record[segment]
  }
  if (cursor === undefined || cursor === null) return ''
  if (typeof cursor === 'string' || typeof cursor === 'number') {
    return String(cursor)
  }
  return ''
}

// ---------------------------------------------------------------------
// Seeded pseudo-randomness.
//
// Box-Muller transforms two uniform-in-(0,1] samples into a standard
// normal. To get reproducible draws without `Math.random`, we derive the
// two uniforms from two murmurhash3 outputs with different sub-seeds.
// ---------------------------------------------------------------------

const HASH_RANGE = 0x100000000 // 2^32

function uniformFromSeed(seed: number, salt: number): number {
  // Combine into a stable string and hash. Add 1 to the numerator so the
  // result is in (0, 1] — Box-Muller requires u1 > 0 (log(0) is -∞).
  const hashed = murmurhash3(`${seed}:${salt}`)
  return (hashed + 1) / (HASH_RANGE + 1)
}

/**
 * Produce a single standard-normal sample deterministically from `seed`.
 *
 * Exported so tests can assert the seeded-random pipeline directly rather
 * than relying on observed bandit decisions.
 */
export function seededGaussian(seed: number): number {
  const u1 = uniformFromSeed(seed, 1)
  const u2 = uniformFromSeed(seed, 2)
  // Box-Muller — z0 has mean 0, variance 1.
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

// ---------------------------------------------------------------------
// Algorithm: epsilon-greedy.
// ---------------------------------------------------------------------

export interface EpsilonGreedyResult {
  action: BanditAction
  actionProbability: number
  exploreFired: boolean
}

export function epsilonGreedy(
  modelPerAction: Record<string, BanditPerActionStats>,
  actions: BanditAction[],
  hashBucket: number,
  explorationRate?: number
): EpsilonGreedyResult {
  if (actions.length === 0) {
    throw new Error('epsilonGreedy: actions list is empty')
  }

  const sorted = sortedActions(actions)
  const epsilon = explorationRate ?? 0.1
  const n = sorted.length
  const bucketFraction = hashBucket / MAX_BUCKET
  const exploreFired = bucketFraction < epsilon

  if (exploreFired) {
    const idx = hashBucket % n
    const action = sorted[idx]!
    return {
      action,
      // Uniform across N candidates under the explore branch.
      actionProbability: epsilon / n,
      exploreFired: true,
    }
  }

  // Exploit branch — pick the highest mean, alphabetical tie-break on id.
  let bestId: string | null = null
  let bestMean = -Infinity
  let bestCount = 0
  for (const action of sorted) {
    const stats = statsFor(modelPerAction, action.id)
    if (stats.mean > bestMean) {
      bestMean = stats.mean
      bestId = action.id
      bestCount = 1
    } else if (stats.mean === bestMean) {
      bestCount += 1
    }
  }

  const action = sorted.find((a) => a.id === bestId)!
  // Exploit probability — among `bestCount` tied winners, each receives
  // an equal share of the exploit mass. Every action also receives an
  // epsilon/N share from the explore branch.
  const exploitMass = (1 - epsilon) / bestCount
  return {
    action,
    actionProbability: exploitMass + epsilon / n,
    exploreFired: false,
  }
}

// ---------------------------------------------------------------------
// Algorithm: Thompson sampling.
// ---------------------------------------------------------------------

export interface ThompsonSampleResult {
  action: BanditAction
  actionProbability: number
}

export function thompsonSample(
  modelPerAction: Record<string, BanditPerActionStats>,
  actions: BanditAction[],
  hashBucket: number
): ThompsonSampleResult {
  if (actions.length === 0) {
    throw new Error('thompsonSample: actions list is empty')
  }

  const sorted = sortedActions(actions)

  let bestId = sorted[0]!.id
  let bestSample = -Infinity

  for (const action of sorted) {
    const stats = statsFor(modelPerAction, action.id)
    // Seed each action independently from the request bucket so the same
    // (hashBucket, actionId) pair always produces the same draw.
    const seed = murmurhash3(`${hashBucket}:${action.id}`)
    const z = seededGaussian(seed)
    const stddev = Math.sqrt(stats.variance / Math.max(stats.samples, 1))
    const sample = stats.mean + z * stddev
    if (sample > bestSample) {
      bestSample = sample
      bestId = action.id
    }
  }

  const action = sorted.find((a) => a.id === bestId)!
  // Analytically computing the posterior selection probability requires
  // integration over the joint posterior — overkill in the hot path.
  // We expose 1/N as a placeholder; downstream analytics that need the
  // true value can recompute offline from the model + seed.
  return { action, actionProbability: 1 / sorted.length }
}

// ---------------------------------------------------------------------
// Algorithm: UCB1.
// ---------------------------------------------------------------------

export interface Ucb1Result {
  action: BanditAction
  actionProbability: number
}

export function ucb1(
  modelPerAction: Record<string, BanditPerActionStats>,
  actions: BanditAction[]
): Ucb1Result {
  if (actions.length === 0) {
    throw new Error('ucb1: actions list is empty')
  }

  const sorted = sortedActions(actions)

  // Cold-start policy — sample every action at least once. When multiple
  // actions are unseen, the lowest id wins (deterministic).
  for (const action of sorted) {
    const stats = statsFor(modelPerAction, action.id)
    if (stats.samples === 0) {
      return { action, actionProbability: 1.0 }
    }
  }

  let totalSamples = 0
  for (const action of sorted) {
    totalSamples += statsFor(modelPerAction, action.id).samples
  }
  const lnTotal = Math.log(Math.max(totalSamples, 1))

  let bestId = sorted[0]!.id
  let bestScore = -Infinity
  for (const action of sorted) {
    const stats = statsFor(modelPerAction, action.id)
    const score =
      stats.mean + Math.sqrt((2 * lnTotal) / Math.max(stats.samples, 1))
    if (score > bestScore) {
      bestScore = score
      bestId = action.id
    }
  }

  const action = sorted.find((a) => a.id === bestId)!
  return { action, actionProbability: 1.0 }
}

// ---------------------------------------------------------------------
// Top-level entry point — what the evaluator calls.
// ---------------------------------------------------------------------

export function evaluateBandit(
  banditKey: string,
  config: BanditConfig,
  context: EvalContext,
  store: BanditModelStore
): { action: BanditAction; banditEntry: BanditDecisionLogEntry } | null {
  const startedAt = performanceNow()
  const model = store.getModel(banditKey)
  if (!model) return null

  // Contextual lookup — when the model declares per-bucket maps and the
  // request's bucket exists, use that. Otherwise fall back to top-level.
  const bucketKey = deriveContextBucket(config, context)
  const perActionMap =
    (bucketKey && model.contextualModels?.[bucketKey]) || model.perAction

  const hashBucket =
    murmurhash3(`${banditKey}:${bucketingKey(context)}`) % MAX_BUCKET

  let action: BanditAction
  let actionProbability: number
  let optimalityGap: number | null

  switch (config.algorithm) {
    case 'epsilon-greedy': {
      const result = epsilonGreedy(
        perActionMap,
        config.actions,
        hashBucket,
        config.explorationRate
      )
      action = result.action
      actionProbability = result.actionProbability
      optimalityGap = result.exploreFired
        ? (config.explorationRate ?? 0.1)
        : null
      break
    }
    case 'thompson-sampling': {
      const result = thompsonSample(perActionMap, config.actions, hashBucket)
      action = result.action
      actionProbability = result.actionProbability
      optimalityGap = null
      break
    }
    case 'ucb1': {
      const result = ucb1(perActionMap, config.actions)
      action = result.action
      actionProbability = result.actionProbability
      optimalityGap = null
      break
    }
    default: {
      // Exhaustive — if a new algorithm is added to BanditConfig the
      // compiler will flag this branch.
      const exhaustive: never = config.algorithm
      throw new Error(`evaluateBandit: unknown algorithm ${String(exhaustive)}`)
    }
  }

  const banditEntry: BanditDecisionLogEntry = {
    flagKey: banditKey,
    value: action.variationId,
    variationKey: null,
    source: 'bandit',
    ruleId: null,
    ruleType: 'bandit',
    reasons: [`bandit "${banditKey}" served action "${action.id}"`],
    evaluatedAt: Date.now(),
    durationMicros: Math.max(0, Math.round((performanceNow() - startedAt) * 1000)),
    contextSummary: contextSummary(context),
    banditKey,
    actionId: action.id,
    modelVersion: model.version,
    actionProbability,
    optimalityGap,
  }

  return { action, banditEntry }
}

// ---------------------------------------------------------------------
// Timing helper — `performance.now()` when available, else `Date.now()`.
// ---------------------------------------------------------------------

function performanceNow(): number {
  const g = globalThis as { performance?: { now?: () => number } }
  if (g.performance && typeof g.performance.now === 'function') {
    return g.performance.now()
  }
  return Date.now()
}

// ---------------------------------------------------------------------
// In-memory model store helper.
// ---------------------------------------------------------------------

export function createInMemoryBanditModelStore(
  initial?: Record<string, BanditModel>
): BanditModelStore {
  const models = new Map<string, BanditModel>()
  if (initial) {
    for (const [key, model] of Object.entries(initial)) {
      models.set(key, model)
    }
  }
  return {
    getModel(banditKey) {
      return models.get(banditKey) ?? null
    },
    updateModel(banditKey, model) {
      models.set(banditKey, model)
    },
  }
}
