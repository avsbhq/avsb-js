/**
 * The typed hooks, and the exposure contract they used to break.
 *
 * THE BUG (report 03 §5, P0): `useBoolFlag` and its siblings called
 * `client.getBoolFlag(key, default)` with no options inside `getSnapshot`.
 * That is a full evaluation, so every render fired an exposure and emitted
 * an evaluation event, and experiment exposure counts became a function of
 * render frequency. These tests drive the real client and count what
 * reaches the tracker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement, type ReactElement, type ReactNode } from 'react'
import type { Flag, FlagDatafile } from '@avsbhq/core'
import { AvsbClient } from '../../avsb-browser/src/AvsbClient'
import type { Tracker } from '../../avsb-browser/src/types'
import * as trackerModule from '../../avsb-browser/src/tracker'
import { AvsbProvider } from './AvsbProvider'
import { useBoolFlag } from './useBoolFlag'
import { useStringFlag } from './useStringFlag'
import { useNumberFlag } from './useNumberFlag'
import { useJsonFlag } from './useJsonFlag'
import { useExposure } from './useExposure'

const SDK_KEY = 'sdk_production_typedhooks00000'

interface Config {
  theme: string
  retries: number
}

function datafile(): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: SDK_KEY,
    environmentKey: 'production',
    publishedAt: '2026-01-01T00:00:00Z',
    collectEndpoint: 'https://collect.test.invalid',
    audiences: [],
    flags: [
      {
        id: 'f_bool',
        key: 'checkout_v2',
        type: 'boolean',
        enabled: true,
        defaultVariationId: 'b_off',
        variations: [
          { id: 'b_off', key: 'off', value: false },
          { id: 'b_on', key: 'on', value: true },
        ],
        overrides: [],
        rules: [
          {
            id: 'r_bool',
            type: 'ab_test',
            enabled: true,
            audienceIds: [],
            hashAttribute: 'userId',
            trafficAllocation: 1,
            variations: [{ variationId: 'b_on', percentage: 1 }],
          },
        ],
      },
      {
        id: 'f_str',
        key: 'cta_copy',
        type: 'string',
        enabled: true,
        defaultVariationId: 's_a',
        variations: [{ id: 's_a', key: 'a', value: 'Buy now' }],
        overrides: [],
        rules: [],
      },
      {
        id: 'f_num',
        key: 'max_items',
        type: 'number',
        enabled: true,
        defaultVariationId: 'n_a',
        variations: [{ id: 'n_a', key: 'a', value: 42 }],
        overrides: [],
        rules: [],
      },
      {
        id: 'f_json',
        key: 'ui_config',
        type: 'json',
        enabled: true,
        defaultVariationId: 'j_a',
        variations: [{ id: 'j_a', key: 'a', value: { theme: 'dark', retries: 5 } }],
        overrides: [],
        rules: [],
      },
    ],
  }
}

function stubTracker(): ReturnType<typeof vi.fn> {
  const queue = vi.fn()
  const tracker: Tracker = {
    queue,
    queueMetric: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  }
  vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)
  return queue
}

/**
 * Hold the datafile response.
 *
 * The provider awaits `client.onReady()`, and that STARTS init on an
 * `autoInit: false` client, so the `beforeEach` stub would hand the datafile
 * over inside the very first `act()` and the client would never be unready.
 */
function holdDatafile(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<never>(() => undefined)),
  )
}

function makeClient(): AvsbClient {
  return new AvsbClient({
    sdkKey: SDK_KEY,
    context: { kind: 'user', key: 'u1' },
    bootstrap: datafile(),
    autoRefresh: false,
    cache: false,
    logLevel: 'silent',
  })
}

function wrap(client: AvsbClient, children: ReactNode): ReactElement {
  return createElement(AvsbProvider, { client, children })
}

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve(datafile()),
      }),
    ),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('typed hooks read without side effects', () => {
  it('fires no exposure while rendering, however many times it renders', async () => {
    const queue = stubTracker()
    const client = makeClient()
    await client.onReady()

    const seen: Flag<boolean>[] = []
    function Probe(): null {
      seen.push(useBoolFlag('checkout_v2', false))
      return null
    }

    await act(async () => {
      render(wrap(client, createElement(Probe)))
    })
    // Force more renders: an unrelated identify re-runs every subscriber.
    await act(async () => {
      client.identify({ kind: 'user', key: 'u1', extra: 1 })
    })
    await act(async () => {
      client.identify({ kind: 'user', key: 'u1', extra: 2 })
    })

    expect(seen.length).toBeGreaterThan(1)
    expect(queue).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()

    await client.close()
  })

  it('returns the same object across renders for each typed getter', async () => {
    stubTracker()
    const client = makeClient()
    await client.onReady()

    const bools: Flag<boolean>[] = []
    const strings: Flag<string>[] = []
    const numbers: Flag<number>[] = []
    const jsons: Flag<Config>[] = []

    function Probe(): null {
      bools.push(useBoolFlag('checkout_v2', false))
      strings.push(useStringFlag('cta_copy', 'default'))
      numbers.push(useNumberFlag('max_items', 0))
      // A fresh object literal every render: the snapshot cache keys on its
      // JSON form, so this must still be one stable entry.
      jsons.push(useJsonFlag<Config>('ui_config', { theme: 'light', retries: 3 }))
      return null
    }

    await act(async () => {
      render(wrap(client, createElement(Probe)))
    })
    await act(async () => {
      client.identify({ kind: 'user', key: 'u1', extra: 3 })
    })

    for (const list of [bools, strings, numbers, jsons]) {
      expect(list.length).toBeGreaterThan(1)
      for (const flag of list) expect(flag).toBe(list[0])
    }
    expect(bools[0].value).toBe(true)
    expect(bools[0].isEnabled()).toBe(true)
    expect(strings[0].value).toBe('Buy now')
    expect(numbers[0].value).toBe(42)
    expect(jsons[0].value).toEqual({ theme: 'dark', retries: 5 })
    expect(consoleError).not.toHaveBeenCalled()

    await client.close()
  })

  it('falls back to the default when the platform type does not match', async () => {
    stubTracker()
    const client = makeClient()
    await client.onReady()

    const seen: Flag<string>[] = []
    function Probe(): null {
      // checkout_v2 is a boolean flag, read here as a string.
      seen.push(useStringFlag('checkout_v2', 'fallback'))
      return null
    }

    await act(async () => {
      render(wrap(client, createElement(Probe)))
    })

    expect(seen[0].value).toBe('fallback')
    expect(seen[0].source).toBe('not_found')
    // A mismatch is reported and survivable, never thrown.
    expect(consoleError).not.toHaveBeenCalled()

    await client.close()
  })
})

describe('useExposure is the other half of the contract', () => {
  it('fires exactly one exposure per mounted view', async () => {
    const queue = stubTracker()
    const client = makeClient()
    await client.onReady()

    function Probe(): null {
      useBoolFlag('checkout_v2', false)
      useExposure('checkout_v2')
      return null
    }

    await act(async () => {
      render(wrap(client, createElement(Probe)))
    })

    expect(queue).toHaveBeenCalledTimes(1)

    // Extra renders must not add exposures.
    await act(async () => {
      client.identify({ kind: 'user', key: 'u1', extra: 4 })
    })
    expect(queue).toHaveBeenCalledTimes(1)

    await client.close()
  })

  it('holds the exposure back while enabled is false', async () => {
    const queue = stubTracker()
    const client = makeClient()
    await client.onReady()

    function Probe({ shown }: { shown: boolean }): null {
      useExposure('checkout_v2', { enabled: shown })
      return null
    }

    let view: ReturnType<typeof render> | null = null
    await act(async () => {
      view = render(wrap(client, createElement(Probe, { shown: false })))
    })
    expect(queue).not.toHaveBeenCalled()

    await act(async () => {
      view?.rerender(wrap(client, createElement(Probe, { shown: true })))
    })
    expect(queue).toHaveBeenCalledTimes(1)

    await client.close()
  })

  it('waits for readiness instead of exposing against a default value', async () => {
    const queue = stubTracker()
    holdDatafile()
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      context: { kind: 'user', key: 'u1' },
      autoInit: false,
      autoRefresh: false,
      cache: false,
      logLevel: 'silent',
    })

    function Probe(): null {
      useExposure('checkout_v2')
      return null
    }

    await act(async () => {
      render(wrap(client, createElement(Probe)))
    })
    expect(queue).not.toHaveBeenCalled()

    await act(async () => {
      client.applyDatafileBootstrap(datafile())
    })

    expect(queue).toHaveBeenCalledTimes(1)

    await client.close()
  })
})
