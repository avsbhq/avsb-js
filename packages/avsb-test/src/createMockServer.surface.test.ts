/**
 * N1-10 (production QA 2026-10-01): the README says `createMockServer`
 * "Mirrors `AvsbServer`", and code calling `alias`, an override method,
 * `on`, `refreshDatafile` and seven more threw a TypeError under the mock.
 * This file holds the mock to the REAL class from @avsbhq/node.
 *
 * Two locks:
 *   1. `SERVER_SURFACE` lists every public member of AvsbServer. `keyof
 *      AvsbServer` holds public members only, and `satisfies` rejects a
 *      missing or an extra name, so a public method added to AvsbServer fails
 *      the typecheck until it is listed, and then fails below until the mock
 *      has it.
 *   2. The per-request client is a plain object on both sides, so its member
 *      names are compared directly at runtime.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlagDatafile } from '@avsbhq/core'
import { AvsbServer } from '@avsbhq/node'
import { createMockServer } from './createMockServer'
import { createTestDatafile } from './fixtures/datafile'

const SERVER_SURFACE = {
  utils: true,
  datasets: true,
  recs: true,
  onReady: true,
  isReady: true,
  close: true,
  flush: true,
  refreshDatafile: true,
  applyDatafileBootstrap: true,
  getDatafile: true,
  getFlag: true,
  getBoolFlag: true,
  getStringFlag: true,
  getNumberFlag: true,
  getJsonFlag: true,
  // Public in TypeScript but documented @internal ("not part of the published
  // API"): UserBoundClient's entry point into the server. Not mirrored.
  evaluateInternal: false,
  getAllFlags: true,
  track: true,
  trackPurchase: true,
  alias: true,
  manualExposure: true,
  forUser: true,
  createUserContext: true,
  setOverrideForUser: true,
  setGlobalOverride: true,
  clearOverrideForUser: true,
  clearGlobalOverride: true,
  clearAllOverrides: true,
  createDecisionLog: true,
  on: true,
  off: true,
} satisfies Record<keyof AvsbServer, boolean>

const USER = { kind: 'user', key: 'u_1' }

function realServer(): AvsbServer {
  const bootstrap: FlagDatafile = {
    ...createTestDatafile({ checkout_v2: true }),
    collectEndpoint: 'https://collect.test.invalid',
  }
  return new AvsbServer({
    sdkKey: 'sdk_test_0000000000000000000',
    bootstrap,
    streaming: false,
    logLevel: 'silent',
  })
}

const servers: AvsbServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  vi.unstubAllGlobals()
})

describe('createMockServer mirrors the AvsbServer surface (N1-10)', () => {
  it('has every public AvsbServer member, with the same kind of value', () => {
    const real = realServer()
    servers.push(real)
    const mock = createMockServer({ flags: { checkout_v2: true } })

    const realMembers = real as unknown as Record<string, unknown>
    const mockMembers = mock as unknown as Record<string, unknown>
    const mirrored = Object.entries(SERVER_SURFACE)
      .filter(([, mirroredOnMock]) => mirroredOnMock)
      .map(([name]) => name)

    const missing = mirrored.filter((name) => mockMembers[name] === undefined)
    expect(missing).toEqual([])
    for (const name of mirrored) {
      expect(typeof mockMembers[name], name).toBe(typeof realMembers[name])
    }
  })

  it('gives forUser() exactly the member names of the real per-request client', () => {
    const real = realServer()
    servers.push(real)
    const mock = createMockServer({ flags: { checkout_v2: true } })

    expect(Object.keys(mock.forUser(USER)).sort()).toEqual(Object.keys(real.forUser(USER)).sort())
  })

  it('gives utils the same helpers as the real server', () => {
    const real = realServer()
    servers.push(real)
    const mock = createMockServer()

    expect(Object.keys(mock.utils).sort()).toEqual(Object.keys(real.utils).sort())
  })
})
