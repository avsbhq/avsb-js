import { DestroyRef, Injector, runInInjectionContext } from '@angular/core'
import { AVSB_CLIENT, AVSB_CONFIG } from '../avsb.tokens'
import { AvsbService } from '../avsb.service'
import type { AngularAvsbClient } from '../clientInterface'
import type { AvsbConfig } from '../types'

/**
 * A `DestroyRef` a test can fire by hand, so signal teardown is observable
 * without booting a component.
 */
export class TestDestroyRef extends DestroyRef {
  private readonly _callbacks: (() => void)[] = []
  private _destroyed = false

  /** Angular's own `DestroyRef` reports this, and code that asks before
   *  registering a late callback reads it. A fake without it is not a
   *  `DestroyRef`. */
  get destroyed(): boolean {
    return this._destroyed
  }

  onDestroy(callback: () => void): () => void {
    this._callbacks.push(callback)
    return () => {
      const index = this._callbacks.indexOf(callback)
      if (index >= 0) this._callbacks.splice(index, 1)
    }
  }

  /** Run every registered teardown, as Angular does on injector destroy. */
  destroy(): void {
    // Flagged before the callbacks run, matching Angular's own order, so a
    // teardown that re-enters sees a destroyed ref rather than a live one.
    this._destroyed = true
    for (const callback of this._callbacks.splice(0)) callback()
  }
}

export interface TestInjectorHandle {
  injector: Injector
  destroyRef: TestDestroyRef
  /**
   * Tear the injection context down the way Angular does when the component
   * that opened it is destroyed.
   *
   * Firing the `DestroyRef` PROVIDER is not enough: `toSignal` (and the rest of
   * `@angular/core`'s injection-context teardown) hangs its cleanup on the
   * injector's own lifecycle, so a test that only fired the provided ref left
   * every subscription open and could not see a leak at all.
   */
  destroy(): void
}

/** A provider shape Angular's untyped `useValue` accepts. */
export interface TestProvider {
  provide: unknown
  useValue: unknown
}

/**
 * An injector carrying the service and a `DestroyRef`, which is everything
 * this package's helpers and template features ask for.
 *
 * `extraProviders` covers the per-feature tokens (`TemplateRef`,
 * `ViewContainerRef`, `ChangeDetectorRef`). They are typed `unknown` because
 * Angular's own `useValue` is untyped, and a feature under test only ever
 * compares them by identity or calls the one method it needs.
 */
export function createTestInjector(
  service: AvsbService,
  extraProviders: TestProvider[] = []
): TestInjectorHandle {
  const destroyRef = new TestDestroyRef()
  const injector = Injector.create({
    providers: [
      { provide: DestroyRef, useValue: destroyRef },
      { provide: AvsbService, useValue: service },
      ...extraProviders,
    ],
  })
  const destroy = (): void => {
    // Both halves: features that inject `DestroyRef` register on the provider,
    // and `toSignal` registers on the injector itself.
    destroyRef.destroy()
    ;(injector as unknown as { destroy?: () => void }).destroy?.()
  }

  return { injector, destroyRef, destroy }
}

/**
 * Build `AvsbService` the way Angular does: from an injector carrying
 * `AVSB_CLIENT` and `AVSB_CONFIG`. The service takes no constructor
 * arguments, so this is the only way to construct one.
 */
export function createTestService(
  client: AngularAvsbClient,
  config: AvsbConfig = { client }
): AvsbService {
  const injector = Injector.create({
    providers: [
      { provide: AVSB_CLIENT, useValue: client },
      { provide: AVSB_CONFIG, useValue: config },
    ],
  })
  return runInInjectionContext(injector, () => new AvsbService())
}
