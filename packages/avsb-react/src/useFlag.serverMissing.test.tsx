/**
 * N1-16 (production QA 2026-10-01): with `serverFlags`, a key the server's
 * datafile did not carry rendered `source: not_ready` in the server HTML and
 * became `not_found` after hydration. `serverFlags` is every flag the server
 * evaluated, so a missing key is `not_found` on the server, through
 * hydration, and after the client loads.
 *
 * Nothing here asserts markup: the probe renders `null` and records the
 * `Flag` each render read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { createFlag } from '@avsbhq/core'
import type { Flag } from '@avsbhq/core'
import { AvsbClient } from '../../avsb-browser/src/AvsbClient'
import { AvsbProvider } from './AvsbProvider'
import { toSerializedFlagMap } from './serverFlags'
import { useFlag } from './useFlag'

const SDK_KEY = 'sdk_production_reactservermiss01'

function serverFlags() {
  return toSerializedFlagMap({
    plan_gate: createFlag<unknown>({
      value: true,
      variationKey: 'on',
      source: 'rule',
      ruleId: 'r_server',
      ruleType: 'ab_test',
      reasons: ['server evaluated'],
    }),
  })
}

function probe(flagKey: string): { Component: () => null; seen: Flag<boolean>[] } {
  const seen: Flag<boolean>[] = []
  function Component(): null {
    seen.push(useFlag(flagKey, false))
    return null
  }
  return { Component, seen }
}

function provider(props: Record<string, unknown>, children: ReactNode) {
  return createElement(AvsbProvider, { ...props, children } as never)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a key missing from serverFlags (N1-16)', () => {
  it('renders not_found with the caller default in the server render', () => {
    const missing = probe('missing_flag')
    const present = probe('plan_gate')

    renderToString(
      provider({ sdkKey: SDK_KEY, serverFlags: serverFlags() }, [
        createElement(missing.Component, { key: 'm' }),
        createElement(present.Component, { key: 'p' }),
      ])
    )

    expect(missing.seen[0].source).toBe('not_found')
    expect(missing.seen[0].value).toBe(false)
    expect(present.seen[0].source).toBe('rule')
  })

  it('still renders not_ready without serverFlags, when nothing has answered', () => {
    const missing = probe('missing_flag')
    renderToString(provider({ sdkKey: SDK_KEY }, createElement(missing.Component)))
    expect(missing.seen[0].source).toBe('not_ready')
  })

  it('keeps not_found through hydration while the client is still loading', async () => {
    // Hold the datafile so the client stays unreadable for the whole pass.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => undefined)))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      context: { kind: 'user', key: 'u1' },
      autoInit: false,
      autoRefresh: false,
      cache: false,
      logLevel: 'silent',
    })
    const missing = probe('missing_flag')

    await act(async () => {
      render(provider({ client, serverFlags: serverFlags() }, createElement(missing.Component)))
    })

    expect(missing.seen.length).toBeGreaterThan(0)
    for (const flag of missing.seen) expect(flag.source).toBe('not_found')
    await client.close()
  })
})
