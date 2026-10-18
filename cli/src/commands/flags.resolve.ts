/**
 * Turning what a person types into what the API accepts.
 *
 * The public API resolves a `{flagId}` path parameter BEFORE the route handler
 * runs (`withContract` → `resolveScopedId`), and that resolver understands
 * exactly two forms: a positive integer short id, or the row's cuid. A flag
 * KEY, which is the name developers actually use, is looked up as a cuid, misses,
 * and comes back 404.
 *
 * Keys are the golden path in our own docs, so the CLI closes the gap on its
 * side: a reference that cannot be an id is resolved to one by listing the
 * project's flags and matching the key, and a direct attempt that 404s is
 * retried the same way. The resolution is printed, so nobody is left wondering
 * which flag was touched.
 *
 * The rules are pure and the API surface is a one-method interface, so every
 * path (key, short id, cuid, miss) is tested without a network.
 */

import { CliError } from '../lib/cliError.js'
import { ApiRequestError } from '../lib/apiError.js'
import { normalizeFlag } from './flags.helpers.js'
import type { ApiFlagListResponse, CliFlag } from '../types/flag.js'

/** How a reference will be addressed. */
export type FlagRefKind = 'shortId' | 'id' | 'key'

/** Matches `scopedIdResolver`'s own POSITIVE_INTEGER: a public numeric short id. */
const SHORT_ID = /^[1-9][0-9]{0,9}$/

/**
 * A cuid is lowercase alphanumeric and long; a flag key is
 * `^[a-z][a-z0-9_]*$` and usually short and underscored. A long, underscore-free,
 * all-lowercase string could be either, so it is treated as an id and falls back
 * to a key lookup on 404 rather than being guessed at.
 */
const CUID_LIKE = /^[a-z][a-z0-9]{20,}$/

export function classifyFlagRef(ref: string): FlagRefKind {
  const value = ref.trim()
  if (SHORT_ID.test(value)) return 'shortId'
  if (CUID_LIKE.test(value)) return 'id'
  return 'key'
}

/** The one call the resolver needs. `FlagsApiClient` satisfies it. */
export interface FlagLister {
  listFlags(
    projectRef: string | number,
    opts?: { limit?: number; cursor?: string },
  ): Promise<ApiFlagListResponse>
}

export interface FlagRefResolution {
  /** The value to put in the path: an id or short id the API can resolve. */
  ref: string
  kind: FlagRefKind
  /** The list row, when the key lookup already fetched it. */
  flag: CliFlag | null
  /** True when a key was translated, so the caller can say so out loud. */
  resolvedByKey: boolean
}

const PAGE_SIZE = 100
/** 50 pages of 100 is more flags than any project will have; it stops a runaway loop. */
const MAX_PAGES = 50

/**
 * Find a flag by key, paging until it appears. Throws a `CliError` naming the
 * key when the project has no such flag.
 */
export async function findFlagByKey(
  api: FlagLister,
  projectShortId: number,
  key: string,
): Promise<CliFlag> {
  let cursor: string | undefined
  const seen: string[] = []

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await api.listFlags(projectShortId, { limit: PAGE_SIZE, cursor })
    for (const wire of response.data) {
      if (wire.key === key) return normalizeFlag(wire)
      if (seen.length < 8) seen.push(wire.key)
    }
    if (!response.page.hasMore || !response.page.nextCursor) break
    cursor = response.page.nextCursor
  }

  throw new CliError(
    'cli_not_found',
    `No flag with key "${key}" in PRJ-${projectShortId}.`,
    seen.length > 0
      ? [`Keys in this project include: ${seen.join(', ')}.`, 'Run `avsb flags list` for all of them.']
      : ['This project has no flags yet. Create one with `avsb flags create <key>`.'],
  )
}

/**
 * Resolve a user-supplied reference to something the API path accepts.
 *
 * Short ids and cuids are passed straight through (no extra request); a key is
 * translated by listing.
 */
export async function resolveFlagRef(
  api: FlagLister,
  projectShortId: number,
  ref: string,
): Promise<FlagRefResolution> {
  const value = ref.trim()
  const kind = classifyFlagRef(value)

  if (kind !== 'key') {
    return { ref: value, kind, flag: null, resolvedByKey: false }
  }

  const flag = await findFlagByKey(api, projectShortId, value)
  return { ref: flag.id, kind, flag, resolvedByKey: true }
}

/**
 * Run an operation against a reference, retrying by key when a direct id
 * attempt 404s.
 *
 * A cuid-shaped key (long, no underscores) is indistinguishable from a real
 * cuid, so the first attempt may legitimately miss; this makes that case work
 * instead of reporting a flag that plainly exists as missing.
 */
export async function withResolvedFlagRef<T>(
  api: FlagLister,
  projectShortId: number,
  ref: string,
  run: (resolution: FlagRefResolution) => Promise<T>,
): Promise<{ result: T; resolution: FlagRefResolution }> {
  const first = await resolveFlagRef(api, projectShortId, ref)

  try {
    return { result: await run(first), resolution: first }
  } catch (err) {
    const notFound = err instanceof ApiRequestError && err.status === 404
    // Only the cuid-shaped case is worth a second attempt: a short id that 404s
    // is genuinely missing, and re-reporting it as a missing KEY would be a
    // worse answer than the platform's own.
    if (!notFound || first.kind !== 'id') throw err

    let flag: CliFlag
    try {
      flag = await findFlagByKey(api, projectShortId, ref.trim())
    } catch {
      // No flag by that key either, so the platform's 404 was the true answer.
      throw err
    }

    const retry: FlagRefResolution = {
      ref: flag.id,
      kind: 'key',
      flag,
      resolvedByKey: true,
    }
    return { result: await run(retry), resolution: retry }
  }
}

/** The line printed when a key was translated, so the target is never a guess. */
export function describeFlagResolution(
  ref: string,
  resolution: FlagRefResolution,
): string | null {
  if (!resolution.resolvedByKey || !resolution.flag) return null
  return `  Matched key ${ref} to FLG-${resolution.flag.shortId}`
}
