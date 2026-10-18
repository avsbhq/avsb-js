import { describe, expect, it } from 'vitest'
import { runInInjectionContext } from '@angular/core'
import { createFlag } from '@avsbhq/core'
import type { Flag } from '@avsbhq/core'
import {
  avsbAllFlagsSignal,
  avsbBoolFlagSignal,
  avsbFlagSignal,
  avsbFlagValueSignal,
  avsbStatusSignal,
} from './signal-helpers'
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

const HERO_A = flagOf('variant-a', 'a')
const HERO_B = flagOf('variant-b', 'b')

function setup(flags: Record<string, Flag<unknown>> = {}, ready = true) {
  const client = new MockAvsbClient(flags)
  if (ready) client.settle({ success: true, source: 'network' })
  const service = createTestService(client)
  const { injector, destroyRef, destroy } = createTestInjector(service)
  return { client, service, injector, destroyRef, destroy }
}

describe('signal helpers', () => {
  it('holds the current value the moment the signal is created', () => {
    const { injector } = setup({ hero: HERO_A })

    const hero = avsbFlagSignal<string>('hero', 'control', { injector })

    // requireSync: no undefined to narrow away, no first-tick placeholder.
    expect(hero().value).toBe('variant-a')
    expect(hero().variationKey).toBe('a')
  })

  it('updates when the flag changes', () => {
    const { client, injector } = setup({ hero: HERO_A })
    const hero = avsbFlagSignal<string>('hero', 'control', { injector })

    client.setFlag('hero', HERO_B)

    expect(hero().value).toBe('variant-b')
  })

  it('reports not_ready before the datafile, then the real decision', () => {
    const { client, injector } = setup({ hero: HERO_A }, false)
    const hero = avsbFlagSignal<string>('hero', 'control', { injector })

    expect(hero().source).toBe('not_ready')
    expect(hero().value).toBe('control')
    expect(hero().exists()).toBe(false)

    client.settle({ success: true, source: 'network' })

    expect(hero().source).toBe('rule')
    expect(hero().value).toBe('variant-a')
  })

  it('fires no exposure while a signal is read', () => {
    const { client, injector } = setup({ hero: HERO_A })
    const hero = avsbFlagSignal<string>('hero', 'control', { injector })

    // Reading a signal is what a template does on every change detection
    // pass; results would be nonsense if that recorded an exposure.
    hero()
    hero()
    client.setFlag('hero', HERO_B)
    hero()

    expect(client.exposures).toEqual([])
  })

  it('releases the store subscription when the injector is destroyed', () => {
    const { client, injector, destroy } = setup({ hero: HERO_A })
    avsbFlagSignal<string>('hero', 'control', { injector })
    expect(client.listenerCount('hero')).toBe(1)

    destroy()

    expect(client.listenerCount('hero')).toBe(0)
  })

  it('works from an ambient injection context with no options', () => {
    const { injector } = setup({ hero: HERO_A })

    const hero = runInInjectionContext(injector, () =>
      avsbFlagSignal<string>('hero', 'control')
    )

    expect(hero().value).toBe('variant-a')
  })

  it('throws a named error when called outside an injection context', () => {
    setup({ hero: HERO_A })

    // No injector, no ambient context: Angular's NG0203, naming the helper
    // rather than naming toSignal.
    expect(() => avsbFlagSignal<string>('hero', 'control')).toThrowError(
      /avsbFlagSignal/
    )
  })

  it('exposes the value-only, typed, all-flags and status shapes', () => {
    const { client, injector } = setup({ hero: HERO_A, dark: flagOf(true, 'on') })

    const heroValue = avsbFlagValueSignal<string>('hero', 'control', { injector })
    const dark = avsbBoolFlagSignal('dark', false, { injector })
    const all = avsbAllFlagsSignal({ injector })
    const status = avsbStatusSignal({ injector })

    expect(heroValue()).toBe('variant-a')
    expect(dark().value).toBe(true)
    expect(Object.keys(all())).toEqual(['hero', 'dark'])
    expect(status()).toBe('ready')
    expect(client.exposures).toEqual([])
  })
})
