import { describe, expect, it } from 'vitest'
import { SimpleChange, runInInjectionContext } from '@angular/core'
import type { SimpleChanges } from '@angular/core'
import { createFlag } from '@avsbhq/core'
import type { Flag } from '@avsbhq/core'
import { AvsbExposureDirective } from './exposure.directive'
import { MockAvsbClient } from './test-support/mockClient'
import { createTestInjector, createTestService } from './test-support/testInjector'

const ON: Flag<boolean> = createFlag<boolean>({
  value: true,
  variationKey: 'on',
  source: 'rule',
  ruleId: 'r1',
  ruleType: 'ab_test',
  reasons: [],
})

function harness(options: { ready?: boolean } = {}) {
  const client = new MockAvsbClient({ 'checkout-v2': ON, 'hero': ON })
  if (options.ready !== false) client.settle({ success: true, source: 'network' })
  const service = createTestService(client)
  const { injector } = createTestInjector(service)
  const directive = runInInjectionContext(
    injector,
    () => new AvsbExposureDirective()
  )
  return { client, directive }
}

describe('AvsbExposureDirective', () => {
  it('records one exposure when the element appears', () => {
    const { client, directive } = harness()
    directive.avsbExposure = 'checkout-v2'

    directive.ngOnInit()

    expect(client.exposures).toEqual(['checkout-v2'])
  })

  it('waits for the datafile before recording', () => {
    const { client, directive } = harness({ ready: false })
    directive.avsbExposure = 'checkout-v2'

    directive.ngOnInit()
    expect(client.exposures).toEqual([])

    client.settle({ success: true, source: 'network' })
    expect(client.exposures).toEqual(['checkout-v2'])
  })

  it('records nothing when the element is destroyed before the datafile arrives', () => {
    const { client, directive } = harness({ ready: false })
    directive.avsbExposure = 'checkout-v2'

    directive.ngOnInit()
    directive.ngOnDestroy()
    client.settle({ success: true, source: 'network' })

    // The visitor never saw the decision, so there is nothing to record.
    expect(client.exposures).toEqual([])
  })

  it('records again when the element switches to another flag', () => {
    const { client, directive } = harness()
    directive.avsbExposure = 'checkout-v2'
    directive.ngOnInit()

    directive.avsbExposure = 'hero'
    const changes: SimpleChanges = {
      avsbExposure: new SimpleChange('checkout-v2', 'hero', false),
    }
    directive.ngOnChanges(changes)

    expect(client.exposures).toEqual(['checkout-v2', 'hero'])
  })

  it('ignores changes that arrive before the element is initialised', () => {
    const { client, directive } = harness()
    directive.avsbExposure = 'checkout-v2'

    // Angular sets inputs and calls ngOnChanges BEFORE the first ngOnInit.
    directive.ngOnChanges({
      avsbExposure: new SimpleChange(undefined, 'checkout-v2', true),
    })

    expect(client.exposures).toEqual([])
  })
})
