import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SimpleChange,
  TemplateRef,
  ViewContainerRef,
  runInInjectionContext,
} from '@angular/core'
import type { SimpleChanges } from '@angular/core'
import { createFlag } from '@avsbhq/core'
import type { Flag } from '@avsbhq/core'
import { AvsbFlagDirective } from './flag.directive'
import { misuseLogger } from './internal/logger'
import { MockAvsbClient } from './test-support/mockClient'
import { createTestInjector, createTestService } from './test-support/testInjector'
import { FakeTemplateRef, FakeViewContainerRef } from './test-support/fakes'

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

const ON = flagOf(true, 'on')
const OFF = flagOf(false, 'off')
const HERO_A = flagOf('variant-a', 'a')
const HERO_CONTROL = flagOf('control', 'control')

interface Harness {
  directive: AvsbFlagDirective
  viewContainer: FakeViewContainerRef
  hostTemplate: FakeTemplateRef
  elseTemplate: FakeTemplateRef
  client: MockAvsbClient
}

function harness(
  flags: Record<string, Flag<unknown>> = {},
  options: { ready?: boolean } = {}
): Harness {
  const client = new MockAvsbClient(flags)
  if (options.ready !== false) client.settle({ success: true, source: 'network' })
  const service = createTestService(client)

  const hostTemplate = new FakeTemplateRef('host')
  const elseTemplate = new FakeTemplateRef('else')
  const viewContainer = new FakeViewContainerRef()

  const { injector } = createTestInjector(service, [
    { provide: TemplateRef, useValue: hostTemplate },
    { provide: ViewContainerRef, useValue: viewContainer },
  ])

  const directive = runInInjectionContext(
    injector,
    () => new AvsbFlagDirective()
  )
  return { directive, viewContainer, hostTemplate, elseTemplate, client }
}

/** The SimpleChanges Angular would hand the directive for these inputs. */
function changesFor(...inputs: string[]): SimpleChanges {
  const changes: SimpleChanges = {}
  for (const input of inputs) {
    changes[input] = new SimpleChange(undefined, undefined, false)
  }
  return changes
}

describe('AvsbFlagDirective', () => {
  afterEach(() => {
    // The misuse logger is a module-level singleton, so a spy on it would
    // otherwise leak into the next test file.
    vi.restoreAllMocks()
  })

  it('renders the host template when the flag is on', () => {
    const h = harness({ 'new-dashboard': ON })
    h.directive.avsbFlag = 'new-dashboard'

    h.directive.ngOnInit()

    expect(h.viewContainer.rendered).toBe(h.hostTemplate)
  })

  it('renders nothing when the flag is off and there is no else template', () => {
    const h = harness({ 'new-dashboard': OFF })
    h.directive.avsbFlag = 'new-dashboard'

    h.directive.ngOnInit()

    expect(h.viewContainer.rendered).toBeNull()
    expect(h.viewContainer.created).toHaveLength(0)
  })

  it('renders the else template when the flag is off', () => {
    const h = harness({ 'new-dashboard': OFF })
    h.directive.avsbFlag = 'new-dashboard'
    h.directive.avsbFlagElse = h.elseTemplate

    h.directive.ngOnInit()

    expect(h.viewContainer.rendered).toBe(h.elseTemplate)
  })

  it('swaps between the two branches as the flag changes', () => {
    const h = harness({ 'new-dashboard': OFF })
    h.directive.avsbFlag = 'new-dashboard'
    h.directive.avsbFlagElse = h.elseTemplate
    h.directive.ngOnInit()
    expect(h.viewContainer.rendered).toBe(h.elseTemplate)

    h.client.setFlag('new-dashboard', ON)
    expect(h.viewContainer.rendered).toBe(h.hostTemplate)

    h.client.setFlag('new-dashboard', OFF)
    expect(h.viewContainer.rendered).toBe(h.elseTemplate)
  })

  it('does not rebuild the view when an unrelated change re-emits the same branch', () => {
    const h = harness({ 'new-dashboard': ON })
    h.directive.avsbFlag = 'new-dashboard'
    h.directive.ngOnInit()

    h.client.notify('new-dashboard')
    h.client.notify('new-dashboard')

    expect(h.viewContainer.created).toHaveLength(1)
  })

  it('shows the else branch before the datafile arrives, then re-decides', () => {
    const h = harness({ 'new-dashboard': ON }, { ready: false })
    h.directive.avsbFlag = 'new-dashboard'
    h.directive.avsbFlagElse = h.elseTemplate
    h.directive.ngOnInit()

    // not_ready is not "off": it is "unknown", and isEnabled() is false, so
    // the else branch is what a visitor sees until the datafile lands.
    expect(h.viewContainer.rendered).toBe(h.elseTemplate)

    h.client.settle({ success: true, source: 'network' })

    expect(h.viewContainer.rendered).toBe(h.hostTemplate)
  })

  it('matches a variation by key with whenVariation', () => {
    const h = harness({ hero: HERO_A })
    h.directive.avsbFlag = 'hero'
    h.directive.avsbFlagDefault = 'control'
    h.directive.avsbFlagWhenVariation = 'a'

    h.directive.ngOnInit()

    expect(h.viewContainer.rendered).toBe(h.hostTemplate)
  })

  it('does not match a different variation key', () => {
    const h = harness({ hero: HERO_CONTROL })
    h.directive.avsbFlag = 'hero'
    h.directive.avsbFlagDefault = 'control'
    h.directive.avsbFlagWhenVariation = 'a'

    h.directive.ngOnInit()

    expect(h.viewContainer.rendered).toBeNull()
  })

  it('matches on the value with whenValue, including a falsy one', () => {
    const h = harness({ 'items-per-page': flagOf(0, 'zero') })
    h.directive.avsbFlag = 'items-per-page'
    h.directive.avsbFlagDefault = 25
    h.directive.avsbFlagWhenValue = 0

    h.directive.ngOnInit()

    // A value match is about equality, not truthiness: 0 matches 0.
    expect(h.viewContainer.rendered).toBe(h.hostTemplate)
  })

  it('requires BOTH matchers to pass when both are set', () => {
    // The misuse warning is asserted in the next test; silence it here so
    // four deliberate misuses do not fill the run output.
    vi.spyOn(misuseLogger, 'warn').mockImplementation(() => {})

    // 'variant-a' lives under variation key 'a', so these two matchers
    // disagree in three of the four combinations.
    const cases: {
      name: string
      variation: string
      value: unknown
      renders: boolean
    }[] = [
      {
        name: 'variation matches, value does not',
        variation: 'a',
        value: 'control',
        renders: false,
      },
      {
        name: 'value matches, variation does not',
        variation: 'b',
        value: 'variant-a',
        renders: false,
      },
      { name: 'neither matches', variation: 'b', value: 'control', renders: false },
      { name: 'both match', variation: 'a', value: 'variant-a', renders: true },
    ]

    for (const testCase of cases) {
      const h = harness({ hero: HERO_A })
      h.directive.avsbFlag = 'hero'
      h.directive.avsbFlagDefault = 'control'
      h.directive.avsbFlagWhenVariation = testCase.variation
      h.directive.avsbFlagWhenValue = testCase.value

      h.directive.ngOnInit()

      expect(h.viewContainer.rendered, testCase.name).toBe(
        testCase.renders ? h.hostTemplate : null
      )
      h.directive.ngOnDestroy()
    }
  })

  it('warns once, naming the flag, when both matchers are set', () => {
    const warn = vi.spyOn(misuseLogger, 'warn').mockImplementation(() => {})
    const h = harness({ hero: HERO_A })
    h.directive.avsbFlag = 'hero'
    h.directive.avsbFlagDefault = 'control'
    h.directive.avsbFlagWhenVariation = 'a'
    h.directive.avsbFlagWhenValue = 'variant-a'

    h.directive.ngOnInit()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('hero')
    expect(warn.mock.calls[0][0]).toContain('whenVariation')
    expect(warn.mock.calls[0][0]).toContain('whenValue')
  })

  it('stays quiet when only one matcher is set', () => {
    const warn = vi.spyOn(misuseLogger, 'warn').mockImplementation(() => {})
    const h = harness({ hero: HERO_A })
    h.directive.avsbFlag = 'hero'
    h.directive.avsbFlagDefault = 'control'
    h.directive.avsbFlagWhenVariation = 'a'

    h.directive.ngOnInit()

    expect(warn).not.toHaveBeenCalled()
  })

  it('re-decides without re-reading when only the condition changes', () => {
    const h = harness({ hero: HERO_A })
    h.directive.avsbFlag = 'hero'
    h.directive.avsbFlagDefault = 'control'
    h.directive.avsbFlagWhenVariation = 'a'
    h.directive.ngOnInit()
    expect(h.viewContainer.rendered).toBe(h.hostTemplate)

    h.directive.avsbFlagWhenVariation = 'b'
    h.directive.ngOnChanges(changesFor('avsbFlagWhenVariation'))

    expect(h.viewContainer.rendered).toBeNull()
  })

  it('re-subscribes when the flag key changes', () => {
    const h = harness({ a: ON, b: OFF })
    h.directive.avsbFlag = 'a'
    h.directive.ngOnInit()
    expect(h.viewContainer.rendered).toBe(h.hostTemplate)

    h.directive.avsbFlag = 'b'
    h.directive.ngOnChanges(changesFor('avsbFlag'))

    expect(h.viewContainer.rendered).toBeNull()
    expect(h.client.listenerCount('a')).toBe(0)
    expect(h.client.listenerCount('b')).toBe(1)
  })

  it('fires no exposure by default', () => {
    const h = harness({ 'new-dashboard': ON })
    h.directive.avsbFlag = 'new-dashboard'

    h.directive.ngOnInit()
    h.client.notify('new-dashboard')

    expect(h.client.exposures).toEqual([])
  })

  it('records exactly one exposure with exposure enabled, however often it re-renders', () => {
    const h = harness({ 'new-dashboard': ON })
    h.directive.avsbFlag = 'new-dashboard'
    h.directive.avsbFlagExposure = true

    h.directive.ngOnInit()
    h.client.notify('new-dashboard')
    h.client.notify('new-dashboard')

    expect(h.client.exposures).toEqual(['new-dashboard'])
  })

  it('unsubscribes and clears the view on destroy', () => {
    const h = harness({ 'new-dashboard': ON })
    h.directive.avsbFlag = 'new-dashboard'
    h.directive.ngOnInit()

    h.directive.ngOnDestroy()

    expect(h.client.listenerCount('new-dashboard')).toBe(0)
    expect(h.viewContainer.rendered).toBeNull()
  })
})
