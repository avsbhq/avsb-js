import { describe, expect, it } from 'vitest'
import { ChangeDetectorRef, runInInjectionContext } from '@angular/core'
import { createFlag } from '@avsbhq/core'
import type { Flag } from '@avsbhq/core'
import { AvsbFlagPipe } from './avsb-flag.pipe'
import { AvsbFlagStatePipe } from './avsb-flag-state.pipe'
import { MockAvsbClient } from '../test-support/mockClient'
import {
  createTestInjector,
  createTestService,
} from '../test-support/testInjector'
import { FakeChangeDetectorRef } from '../test-support/fakes'

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

const OFF = flagOf(false, 'off')
const ON = flagOf(true, 'on')

function harness(
  flags: Record<string, Flag<unknown>> = {},
  options: { ready?: boolean } = {}
) {
  const client = new MockAvsbClient(flags)
  if (options.ready !== false) client.settle({ success: true, source: 'network' })
  const service = createTestService(client)
  const changeDetector = new FakeChangeDetectorRef()
  const { injector } = createTestInjector(service, [
    { provide: ChangeDetectorRef, useValue: changeDetector },
  ])
  const pipe = runInInjectionContext(injector, () => new AvsbFlagPipe())
  const statePipe = runInInjectionContext(injector, () => new AvsbFlagStatePipe())
  return { client, pipe, statePipe, changeDetector }
}

describe('AvsbFlagPipe', () => {
  it('returns the real value on the first call, not the default', () => {
    const { pipe } = harness({ 'dark-mode': ON })

    // The stream emits synchronously on subscribe, so there is no first-call
    // window where the pipe has to invent an answer.
    expect(pipe.transform('dark-mode', false)).toBe(true)
  })

  it('returns the default while the SDK is not ready', () => {
    const { pipe, client } = harness({ 'dark-mode': ON }, { ready: false })

    expect(pipe.transform('dark-mode', false)).toBe(false)

    client.settle({ success: true, source: 'network' })
    expect(pipe.transform('dark-mode', false)).toBe(true)
  })

  it('keeps a real false rather than falling back to the default', () => {
    const { pipe } = harness({ 'dark-mode': OFF })

    // The old pipe used `undefined` as its "nothing yet" marker and could
    // hand back the default in place of a real value; a served false is a
    // decision and must survive.
    expect(pipe.transform('dark-mode', true)).toBe(false)
  })

  it('follows later changes and marks the view for check', () => {
    const { pipe, client, changeDetector } = harness({ 'dark-mode': OFF })
    expect(pipe.transform('dark-mode', false)).toBe(false)
    expect(changeDetector.markForCheckCount).toBe(0)

    client.setFlag('dark-mode', ON)

    expect(pipe.transform('dark-mode', false)).toBe(true)
    expect(changeDetector.markForCheckCount).toBe(1)
  })

  it('re-subscribes when the key changes', () => {
    const { pipe, client } = harness({ a: ON, b: OFF })

    expect(pipe.transform('a', false)).toBe(true)
    expect(pipe.transform('b', false)).toBe(false)
    expect(client.listenerCount('a')).toBe(0)
    expect(client.listenerCount('b')).toBe(1)
  })

  it('re-subscribes when the default changes for the same key', () => {
    const { pipe } = harness()

    expect(pipe.transform('missing', 'first')).toBe('first')
    expect(pipe.transform('missing', 'second')).toBe('second')
  })

  it('fires no exposure', () => {
    const { pipe, client } = harness({ 'dark-mode': ON })

    pipe.transform('dark-mode', false)
    pipe.transform('dark-mode', false)

    expect(client.exposures).toEqual([])
  })

  it('releases its subscription on destroy', () => {
    const { pipe, client } = harness({ 'dark-mode': ON })
    pipe.transform('dark-mode', false)
    expect(client.listenerCount('dark-mode')).toBe(1)

    pipe.ngOnDestroy()

    expect(client.listenerCount('dark-mode')).toBe(0)
  })
})

describe('AvsbFlagStatePipe', () => {
  it('tells "no datafile yet" apart from a real false', () => {
    const { statePipe, client } = harness({ 'dark-mode': OFF }, { ready: false })

    const pending = statePipe.transform('dark-mode', false)
    expect(pending.value).toBe(false)
    expect(pending.source).toBe('not_ready')
    expect(pending.exists()).toBe(false)

    client.settle({ success: true, source: 'network' })

    const settled = statePipe.transform('dark-mode', false)
    expect(settled.value).toBe(false)
    expect(settled.source).toBe('rule')
    expect(settled.exists()).toBe(true)
    expect(settled.isEnabled()).toBe(false)
  })

  it('tells "not in the datafile" apart from "no datafile yet"', () => {
    const { statePipe } = harness({})

    const missing = statePipe.transform('typo-in-key', false)

    expect(missing.source).toBe('not_found')
    expect(missing.exists()).toBe(false)
    expect(missing.value).toBe(false)
  })

  it('carries the decision metadata a template may branch on', () => {
    const { statePipe } = harness({ hero: flagOf('variant-a', 'a') })

    const state = statePipe.transform('hero', 'control')

    expect(state.variationKey).toBe('a')
    expect(state.ruleType).toBe('ab_test')
    expect(state.source).toBe('rule')
  })
})
