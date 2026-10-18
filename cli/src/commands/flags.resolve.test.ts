import { describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '../lib/apiError.js'
import { CliError } from '../lib/cliError.js'
import {
  classifyFlagRef,
  describeFlagResolution,
  findFlagByKey,
  resolveFlagRef,
  withResolvedFlagRef,
  type FlagLister,
} from './flags.resolve.js'
import type { ApiFlagListResponse, WireFlag } from '../types/flag.js'

const CUID = 'cmnoa4mfm0002s601kx8fabcd'

function wireFlag(key: string, shortId: number, id = `flag_${shortId}`): WireFlag {
  return {
    id,
    shortId,
    name: key,
    key,
    type: 'BOOLEAN',
    status: 'RUNNING',
    stale: false,
    description: null,
    variations: [],
    envConfigs: [],
  }
}

/** A lister whose pages are handed in, so paging is exercised without a network. */
function lister(pages: WireFlag[][]): FlagLister & { calls: number } {
  const api = {
    calls: 0,
    async listFlags(
      _projectRef: string | number,
      opts: { limit?: number; cursor?: string } = {},
    ): Promise<ApiFlagListResponse> {
      const index = opts.cursor ? Number(opts.cursor) : 0
      api.calls += 1
      const isLast = index >= pages.length - 1
      return {
        data: pages[index] ?? [],
        page: { nextCursor: isLast ? null : String(index + 1), hasMore: !isLast },
      }
    },
  }
  return api
}

describe('classifyFlagRef', () => {
  it('treats a positive integer as a short id, matching the API resolver', () => {
    expect(classifyFlagRef('12')).toBe('shortId')
    expect(classifyFlagRef('300015')).toBe('shortId')
  })

  it('treats a long lowercase alphanumeric string as an id', () => {
    expect(classifyFlagRef(CUID)).toBe('id')
  })

  it('treats anything a flag key can look like as a key', () => {
    expect(classifyFlagRef('checkout_v2')).toBe('key')
    expect(classifyFlagRef('hero')).toBe('key')
    expect(classifyFlagRef('0')).toBe('key')
  })
})

describe('resolveFlagRef', () => {
  it('passes a short id straight through, with no extra request', async () => {
    const api = lister([[]])

    const resolution = await resolveFlagRef(api, 10, '12')

    expect(resolution).toEqual({ ref: '12', kind: 'shortId', flag: null, resolvedByKey: false })
    expect(api.calls).toBe(0)
  })

  it('passes an id straight through, with no extra request', async () => {
    const api = lister([[]])

    const resolution = await resolveFlagRef(api, 10, CUID)

    expect(resolution.ref).toBe(CUID)
    expect(resolution.kind).toBe('id')
    expect(api.calls).toBe(0)
  })

  it('translates a key to the id the API path needs', async () => {
    const api = lister([[wireFlag('other', 3), wireFlag('checkout_v2', 12)]])

    const resolution = await resolveFlagRef(api, 10, 'checkout_v2')

    expect(resolution.ref).toBe('flag_12')
    expect(resolution.resolvedByKey).toBe(true)
    expect(resolution.flag?.shortId).toBe(12)
  })

  it('pages until the key appears', async () => {
    const api = lister([[wireFlag('a', 1)], [wireFlag('b', 2)], [wireFlag('checkout_v2', 12)]])

    const resolution = await resolveFlagRef(api, 10, 'checkout_v2')

    expect(resolution.ref).toBe('flag_12')
    expect(api.calls).toBe(3)
  })

  it('names the key and shows what does exist when it is not there', async () => {
    const api = lister([[wireFlag('alpha', 1), wireFlag('beta', 2)]])

    await expect(resolveFlagRef(api, 10, 'missing_flag')).rejects.toThrow(CliError)
    await expect(resolveFlagRef(api, 10, 'missing_flag')).rejects.toThrow(/missing_flag/)
  })

  it('tells an empty project to create a flag rather than listing nothing', async () => {
    const api = lister([[]])

    try {
      await findFlagByKey(api, 10, 'checkout_v2')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as CliError).code).toBe('cli_not_found')
      expect((err as CliError).hints.join(' ')).toContain('avsb flags create')
    }
  })
})

describe('withResolvedFlagRef', () => {
  it('runs the operation once for an id that works', async () => {
    const api = lister([[]])
    const run = vi.fn().mockResolvedValue('ok')

    const { result, resolution } = await withResolvedFlagRef(api, 10, CUID, run)

    expect(result).toBe('ok')
    expect(resolution.resolvedByKey).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('retries by key when a cuid-shaped KEY 404s, instead of reporting it missing', async () => {
    // `checkoutredesignvariantb` is a legal flag key AND cuid-shaped, so the
    // first attempt addresses it as an id and the platform answers 404.
    const ambiguous = 'checkoutredesignvariantb'
    const api = lister([[wireFlag(ambiguous, 12)]])
    const run = vi
      .fn()
      .mockRejectedValueOnce(new ApiRequestError({ status: 404, message: 'Flag not found' }))
      .mockResolvedValueOnce('ok')

    const { result, resolution } = await withResolvedFlagRef(api, 10, ambiguous, run)

    expect(result).toBe('ok')
    expect(resolution.resolvedByKey).toBe(true)
    expect(resolution.ref).toBe('flag_12')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not retry a failure that is not a 404', async () => {
    const api = lister([[]])
    const run = vi
      .fn()
      .mockRejectedValue(new ApiRequestError({ status: 403, message: 'Forbidden' }))

    await expect(withResolvedFlagRef(api, 10, CUID, run)).rejects.toThrow('Forbidden')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not retry when the reference was already resolved from a key', async () => {
    const api = lister([[wireFlag('checkout_v2', 12)]])
    const run = vi
      .fn()
      .mockRejectedValue(new ApiRequestError({ status: 404, message: 'Flag not found' }))

    await expect(withResolvedFlagRef(api, 10, 'checkout_v2', run)).rejects.toThrow('Flag not found')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not turn a missing short id into a missing key', async () => {
    const api = lister([[wireFlag('checkout_v2', 12)]])
    const run = vi
      .fn()
      .mockRejectedValue(new ApiRequestError({ status: 404, message: 'Flag not found' }))

    // The platform's own answer is the true one for a short id.
    await expect(withResolvedFlagRef(api, 10, '999', run)).rejects.toThrow('Flag not found')
    expect(api.calls).toBe(0)
  })

  it('keeps the platform 404 when the key lookup also finds nothing', async () => {
    const api = lister([[wireFlag('something_else', 3)]])
    const run = vi
      .fn()
      .mockRejectedValue(new ApiRequestError({ status: 404, message: 'Flag not found' }))

    await expect(withResolvedFlagRef(api, 10, CUID, run)).rejects.toThrow('Flag not found')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('describeFlagResolution', () => {
  it('reports the match so the target is never a guess', () => {
    expect(
      describeFlagResolution('checkout_v2', {
        ref: 'flag_12',
        kind: 'key',
        flag: { shortId: 12 } as never,
        resolvedByKey: true,
      }),
    ).toContain('FLG-12')
  })

  it('says nothing when the reference needed no translation', () => {
    expect(
      describeFlagResolution('12', { ref: '12', kind: 'shortId', flag: null, resolvedByKey: false }),
    ).toBeNull()
  })
})
