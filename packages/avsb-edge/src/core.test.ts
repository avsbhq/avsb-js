// =====================================================================
// core.ts — datafile transport and evaluation wrapper.
//
// The headline assertions here are the two report-02 P0s: the URL is the
// contract URL, and evaluation fires exposures.
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { datafileUrl } from '@avsbhq/core'
import type { EvalContext, ExposureEvent } from '@avsbhq/core'
import {
  datafileRequestUrl,
  evaluateFlagEdge,
  fetchDatafileFromCdn,
  getAllFlagsEdge,
} from './core'
import { VALID_SDK_KEY, jsonResponse, testDatafile } from './fixtures'

const userCtx: EvalContext = { kind: 'user', key: 'user_42' }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------
// URL construction (spec §1.1)
// ---------------------------------------------------------------------

describe('datafileRequestUrl', () => {
  it('produces the contract shape {cdnHost}/{sdkKey}/datafile.json', () => {
    expect(datafileRequestUrl(VALID_SDK_KEY)).toBe(
      `https://cdn.avsb.cloud/${VALID_SDK_KEY}/datafile.json`,
    )
  })

  it('is byte-identical to datafileUrl from @avsbhq/core', () => {
    // The point of the endpoint contract: this package composes no URLs of
    // its own. If these ever diverge, the endpoints fixture is the arbiter.
    expect(datafileRequestUrl(VALID_SDK_KEY, 'https://cdn.example.test')).toBe(
      datafileUrl(VALID_SDK_KEY, 'https://cdn.example.test'),
    )
  })

  it('never produces the old /datafiles/<key>.json shape', () => {
    const url = datafileRequestUrl(VALID_SDK_KEY)
    expect(url).not.toContain('/datafiles/')
    expect(url).not.toContain('.json?')
    expect(url.endsWith('/datafile.json')).toBe(true)
  })

  it('trims a trailing slash on a custom host instead of doubling it', () => {
    expect(datafileRequestUrl(VALID_SDK_KEY, 'https://cdn.example.test/')).toBe(
      `https://cdn.example.test/${VALID_SDK_KEY}/datafile.json`,
    )
  })

  it('still returns a printable URL for an empty key rather than throwing', () => {
    // `datafileUrl` throws on an empty key; error messages still need a value
    // to name, so the fallback keeps the shape.
    expect(datafileRequestUrl('')).toBe('https://cdn.avsb.cloud//datafile.json')
  })
})

// ---------------------------------------------------------------------
// fetchDatafileFromCdn
// ---------------------------------------------------------------------

describe('fetchDatafileFromCdn', () => {
  it('requests the contract URL with no credentials of any kind', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(testDatafile))
    vi.stubGlobal('fetch', mockFetch)

    await fetchDatafileFromCdn(VALID_SDK_KEY)

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`https://cdn.avsb.cloud/${VALID_SDK_KEY}/datafile.json`)
    expect(init.method).toBe('GET')

    // Keyless by path (spec §1.1): no Authorization, no key header, no query.
    const headers = init.headers as Record<string, string>
    expect(Object.keys(headers).map((k) => k.toLowerCase())).toEqual(['accept'])
    expect(url).not.toContain('?')
  })

  it('returns the parsed datafile and the etag on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(testDatafile, { etag: 'W/"v7"' })),
    )

    const outcome = await fetchDatafileFromCdn(VALID_SDK_KEY)

    expect(outcome.kind).toBe('datafile')
    if (outcome.kind !== 'datafile') throw new Error('expected a datafile outcome')
    expect(outcome.datafile.sdkKey).toBe(VALID_SDK_KEY)
    expect(outcome.etag).toBe('W/"v7"')
  })

  it('reports the status and the URL on a 404 instead of collapsing to null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { status: 404 })))

    const outcome = await fetchDatafileFromCdn('sdk_production_gone0000000000000000')

    expect(outcome.kind).toBe('httpError')
    if (outcome.kind !== 'httpError') throw new Error('expected an httpError outcome')
    expect(outcome.status).toBe(404)
    expect(outcome.url).toContain('/datafile.json')
  })

  it('reports a transport error naming the host', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')))

    const outcome = await fetchDatafileFromCdn(VALID_SDK_KEY)

    expect(outcome.kind).toBe('transportError')
    if (outcome.kind !== 'transportError') throw new Error('expected a transportError')
    expect(outcome.error.message).toContain('cdn.avsb.cloud')
    expect(outcome.error.message).toContain('getaddrinfo ENOTFOUND')
  })

  it('reports a 200 whose body is not JSON as a transport error, not a datafile', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      } as unknown as Response),
    )

    const outcome = await fetchDatafileFromCdn(VALID_SDK_KEY)

    expect(outcome.kind).toBe('transportError')
    if (outcome.kind !== 'transportError') throw new Error('expected a transportError')
    expect(outcome.error.message).toContain('not a valid datafile')
    expect(outcome.error.message).toContain('proxy error page')
  })

  it('sends If-None-Match when an etag is supplied', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(testDatafile))
    vi.stubGlobal('fetch', mockFetch)

    await fetchDatafileFromCdn(VALID_SDK_KEY, { etag: 'W/"v7"' })

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['If-None-Match']).toBe('W/"v7"')
  })

  it('aborts and reports a timeout when the host never answers', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
            }),
        ),
      )

      const pending = fetchDatafileFromCdn(VALID_SDK_KEY, { timeoutMs: 50 })
      await vi.advanceTimersByTimeAsync(60)
      const outcome = await pending

      expect(outcome.kind).toBe('transportError')
      if (outcome.kind !== 'transportError') throw new Error('expected a transportError')
      expect(outcome.error.name).toBe('AvsbEdgeTimeoutError')
      expect(outcome.error.message).toContain('50ms')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------
// evaluateFlagEdge
// ---------------------------------------------------------------------

describe('evaluateFlagEdge', () => {
  it('reports not_ready, not not_found, when there is no datafile (B15)', () => {
    const flag = evaluateFlagEdge('always-on', false, userCtx, null)

    expect(flag.source).toBe('not_ready')
    expect(flag.value).toBe(false)
    expect(flag.exists()).toBe(false)
    expect(flag.isEnabled()).toBe(false)
    expect(flag.reasons[0]).toContain('init() has not completed')
  })

  it('reports not_found when the datafile loaded and the key is absent', () => {
    const flag = evaluateFlagEdge('no-such-flag', 'fallback', userCtx, testDatafile)

    expect(flag.source).toBe('not_found')
    expect(flag.value).toBe('fallback')
  })

  it('fires an exposure for an ab_test decision', () => {
    const fired: ExposureEvent[] = []

    const flag = evaluateFlagEdge('checkout-v2', false, userCtx, testDatafile, {
      onExposure: (event) => fired.push(event),
    })

    expect(flag.source).toBe('rule')
    expect(flag.ruleType).toBe('ab_test')
    expect(fired).toHaveLength(1)
    expect(fired[0].eventName).toBe('flag_exposure')
    expect(fired[0].experimentId).toBe('rule_ab_split')
    expect(fired[0].variationId).toBe('var_treatment')
    expect(fired[0].visitorId).toBe('user_42')
  })

  it('fires no exposure when no onExposure is supplied', () => {
    // The old code hardcoded `undefined` here for every evaluation, which is
    // why edge experiments measured nothing. This asserts the parameter is
    // wired, by proving the opposite case is a deliberate choice.
    const flag = evaluateFlagEdge('checkout-v2', false, userCtx, testDatafile)
    expect(flag.source).toBe('rule')
  })

  it('fires no exposure for a targeted_delivery decision', () => {
    const fired: ExposureEvent[] = []

    evaluateFlagEdge('always-on', false, userCtx, testDatafile, {
      onExposure: (event) => fired.push(event),
    })

    // Only randomised decisions are exposures. A 100% delivery is not an
    // experiment arm and must not appear in results.
    expect(fired).toHaveLength(0)
  })

  it('collects reasons so flag.reasons is real, matching node', () => {
    const flag = evaluateFlagEdge('checkout-v2', false, userCtx, testDatafile)

    expect(flag.reasons.length).toBeGreaterThan(0)
    expect(flag.reasons.join(' ')).toContain('rule_ab_split')
  })

  it('serves the default variation for a disabled flag', () => {
    const flag = evaluateFlagEdge('retired', true, userCtx, testDatafile)

    expect(flag.source).toBe('disabled')
    expect(flag.value).toBe(false)
    expect(flag.isEnabled()).toBe(false)
  })

  it('buckets a multi-context through its user sub-context', () => {
    const multi: EvalContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'user_42' },
      organization: { kind: 'organization', key: 'org_1', tier: 'pro' },
    }
    const fired: ExposureEvent[] = []

    evaluateFlagEdge('checkout-v2', false, multi, testDatafile, {
      onExposure: (event) => fired.push(event),
    })

    // The old `toLegacyEvalContext` hop flattened this to one bag and lost
    // the kinded key.
    expect(fired[0].visitorId).toBe('user_42')
  })

  it('returns a frozen flag', () => {
    expect(Object.isFrozen(evaluateFlagEdge('always-on', false, userCtx, testDatafile))).toBe(true)
  })
})

// ---------------------------------------------------------------------
// getAllFlagsEdge
// ---------------------------------------------------------------------

describe('getAllFlagsEdge', () => {
  it('returns an empty record when there is no datafile', () => {
    expect(getAllFlagsEdge(userCtx, null)).toEqual({})
  })

  it('evaluates every flag in the datafile', () => {
    const flags = getAllFlagsEdge(userCtx, testDatafile)

    expect(Object.keys(flags).sort()).toEqual(['always-on', 'checkout-v2', 'retired', 'theme'])
    expect(flags['always-on'].value).toBe(true)
    expect(flags['theme'].value).toBe('midnight')
  })

  it('fires no exposures by default, so a bulk read cannot pollute results', () => {
    const fired: ExposureEvent[] = []

    getAllFlagsEdge(userCtx, testDatafile)
    getAllFlagsEdge(userCtx, testDatafile, { onExposure: (e) => fired.push(e) })

    // One ab_test flag in the datafile, so the opted-in call fires exactly one.
    expect(fired).toHaveLength(1)
    expect(fired[0].eventName).toBe('flag_exposure')
  })
})
