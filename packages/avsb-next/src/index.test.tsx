/**
 * The server-to-client wire shape, round-tripped.
 *
 * `@avsbhq/next` writes `SerializedFlagMap`; `@avsbhq/react` reads it back
 * into real `Flag` objects. The two halves live in different packages, so
 * this test drives the real reviver (imported from source, not from that
 * package's build output) against the real writer. If either side drifts,
 * this fails instead of a customer's server render quietly showing
 * defaults.
 */
import { describe, it, expect } from 'vitest'
import type { EvalContext, FlagDatafile } from '@avsbhq/core'
import { reviveServerFlags } from '../../avsb-react/src/serverFlags'
import { evaluateServerFlags, serializeFlag } from './serverFlags'
import { evaluateFlagServer } from './evaluateFlagServer'

const CONTEXT: EvalContext = { kind: 'user', key: 'u_1', plan: 'pro' }

function datafile(): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: 'sdk_production_wireshape0000',
    environmentKey: 'production',
    publishedAt: '2026-01-01T00:00:00.000Z',
    collectEndpoint: 'https://collect.test.invalid',
    audiences: [
      {
        id: 'aud_pro',
        rules: {
          id: 'g1',
          logic: 'AND',
          conditions: [
            {
              id: 'c1',
              type: 'CUSTOM_ATTRIBUTE',
              attribute: 'plan',
              operator: 'equals',
              value: 'pro',
            },
          ],
        },
      },
    ],
    flags: [
      {
        id: 'f_gate',
        key: 'plan_gate',
        type: 'boolean',
        enabled: true,
        defaultVariationId: 'v_off',
        variations: [
          { id: 'v_off', key: 'off', value: false },
          { id: 'v_on', key: 'on', value: true },
        ],
        overrides: [],
        rules: [
          {
            id: 'r_plan',
            type: 'ab_test',
            enabled: true,
            audienceIds: ['aud_pro'],
            hashAttribute: 'userId',
            trafficAllocation: 1,
            variations: [{ variationId: 'v_on', percentage: 1 }],
          },
        ],
      },
      {
        id: 'f_copy',
        key: 'cta_copy',
        type: 'string',
        enabled: true,
        defaultVariationId: 'v_a',
        variations: [{ id: 'v_a', key: 'a', value: 'Buy now' }],
        overrides: [],
        rules: [],
      },
    ],
  }
}

describe('server flags on the wire', () => {
  it('carries every flag in the datafile', () => {
    const serialized = evaluateServerFlags(datafile(), CONTEXT)

    expect(Object.keys(serialized).sort()).toEqual(['cta_copy', 'plan_gate'])
  })

  it('survives JSON and comes back as working Flag objects', () => {
    const serialized = evaluateServerFlags(datafile(), CONTEXT)

    // What Next.js does to props on their way to the browser.
    const overTheWire = JSON.parse(JSON.stringify(serialized))
    const revived = reviveServerFlags(overTheWire)

    expect(revived['plan_gate'].value).toBe(true)
    expect(revived['plan_gate'].source).toBe('rule')
    // The methods are rebuilt: JSON dropped them, which is why the client
    // revives rather than trusting the raw object.
    expect(revived['plan_gate'].isEnabled()).toBe(true)
    expect(revived['plan_gate'].exists()).toBe(true)
    expect(revived['cta_copy'].value).toBe('Buy now')
  })

  it('matches what the same evaluation returns in process', () => {
    const df = datafile()
    const direct = evaluateFlagServer(df, CONTEXT, 'plan_gate', false)
    const revived = reviveServerFlags(evaluateServerFlags(df, CONTEXT))['plan_gate']

    expect(revived.value).toBe(direct.value)
    expect(revived.source).toBe(direct.source)
    expect(revived.variationKey).toBe(direct.variationKey)
    expect(revived.isEnabled()).toBe(direct.isEnabled())
  })

  it('evaluates for the context it was given, not a default visitor', () => {
    const df = datafile()
    const pro = reviveServerFlags(evaluateServerFlags(df, CONTEXT))
    const free = reviveServerFlags(
      evaluateServerFlags(df, { kind: 'user', key: 'u_1', plan: 'free' }),
    )

    expect(pro['plan_gate'].value).toBe(true)
    expect(free['plan_gate'].value).toBe(false)
  })

  it('drops entries that are not flags rather than half-building them', () => {
    const revived = reviveServerFlags({
      good: serializeFlag(evaluateFlagServer(datafile(), CONTEXT, 'cta_copy', '')),
      // Whatever this is, it is not one of ours.
      bad: { value: 1 } as unknown as ReturnType<typeof serializeFlag>,
    })

    expect(Object.keys(revived)).toEqual(['good'])
  })

  it('treats a missing map as no server values at all', () => {
    expect(reviveServerFlags(null)).toEqual({})
    expect(reviveServerFlags(undefined)).toEqual({})
  })
})
