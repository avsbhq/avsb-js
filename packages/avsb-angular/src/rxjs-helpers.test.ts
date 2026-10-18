import { describe, expect, it } from 'vitest'
import { runInInjectionContext } from '@angular/core'
import { createFlag } from '@avsbhq/core'
import type { Flag } from '@avsbhq/core'
import {
  avsbAllFlags$,
  avsbBoolFlag$,
  avsbFlag$,
  avsbFlagValue$,
  avsbIdentify,
  avsbRecordExposure,
  avsbReset,
  avsbStatus$,
  avsbTrack,
} from './rxjs-helpers'
import { MockAvsbClient } from './test-support/mockClient'
import { createTestInjector, createTestService } from './test-support/testInjector'

function flagOf<T>(value: T, variationKey: string): Flag<T> {
  return createFlag<T>({
    value,
    variationKey,
    source: 'rule',
    ruleId: 'r1',
    ruleType: 'ab_test',
    reasons: [],
  })
}

function setup(flags: Record<string, Flag<unknown>> = {}) {
  const client = new MockAvsbClient(flags)
  client.settle({ success: true, source: 'network' })
  const service = createTestService(client)
  const { injector } = createTestInjector(service)
  return { client, service, injector }
}

describe('Observable helpers', () => {
  it('read through the service resolved from the given injector', () => {
    const { injector } = setup({ hero: flagOf('variant-a', 'a') })
    const seen: string[] = []

    avsbFlag$<string>('hero', 'control', { injector }).subscribe((flag) =>
      seen.push(flag.value)
    )

    expect(seen).toEqual(['variant-a'])
  })

  it('work from an ambient injection context with no options', () => {
    const { injector } = setup({ hero: flagOf('variant-a', 'a') })

    const value$ = runInInjectionContext(injector, () =>
      avsbFlagValue$<string>('hero', 'control')
    )
    const seen: string[] = []
    value$.subscribe((value) => seen.push(value))

    expect(seen).toEqual(['variant-a'])
  })

  it('throw a named error outside an injection context', () => {
    setup()

    expect(() => avsbFlag$('hero', 'control')).toThrowError(/avsbFlag\$/)
    expect(() => avsbTrack('purchase')).toThrowError(/avsbTrack/)
  })

  it('return the Flag wrapper from the typed helpers, not a bare value', () => {
    const { injector } = setup({ dark: flagOf(true, 'on') })
    const seen: Flag<boolean>[] = []

    avsbBoolFlag$('dark', false, { injector }).subscribe((flag) => seen.push(flag))

    expect(seen[0].value).toBe(true)
    expect(seen[0].variationKey).toBe('on')
    expect(seen[0].isEnabled()).toBe(true)
  })

  it('expose status and all flags', () => {
    const { injector } = setup({ dark: flagOf(true, 'on') })
    const statuses: string[] = []
    const all: Record<string, Flag>[] = []

    avsbStatus$({ injector }).subscribe((status) => statuses.push(status))
    avsbAllFlags$({ injector }).subscribe((flags) => all.push(flags))

    expect(statuses).toEqual(['ready'])
    expect(Object.keys(all[0])).toEqual(['dark'])
  })

  it('forward the action helpers to the client', () => {
    const { client, injector } = setup({ hero: flagOf('variant-a', 'a') })

    avsbTrack('purchase', { value: 12 }, { injector })
    avsbIdentify({ kind: 'user', key: 'u_1' }, { injector })
    avsbReset({ injector })
    avsbRecordExposure('hero', 'control', { injector })

    expect(client.tracked).toEqual([{ eventKey: 'purchase', payload: { value: 12 } }])
    expect(client.identified).toEqual([{ kind: 'user', key: 'u_1' }])
    expect(client.resetCount).toBe(1)
    expect(client.exposures).toEqual(['hero'])
  })

  it('fire no exposure from a read', () => {
    const { client, injector } = setup({ hero: flagOf('variant-a', 'a') })

    avsbFlag$<string>('hero', 'control', { injector }).subscribe()
    avsbFlagValue$<string>('hero', 'control', { injector }).subscribe()

    expect(client.exposures).toEqual([])
  })
})
