import { Directive, Input, inject } from '@angular/core'
import type { OnChanges, OnDestroy, OnInit, SimpleChanges } from '@angular/core'
import type { AvsbFlagKey } from '@avsbhq/core'
import { AvsbService } from './avsb.service'

/**
 * Record that this visitor was shown the decision for a flag.
 *
 * Reads in this package are exposure-free on purpose, so change detection
 * cannot inflate experiment results. Put this on the element that actually
 * shows the variation, and the exposure is recorded once, when it appears:
 *
 * ```html
 * <section *avsbFlag="'checkout-v2'">
 *   <app-new-checkout avsbExposure="checkout-v2" />
 * </section>
 * ```
 *
 * It also covers the case where the variation arrives as an input rather
 * than from a read here (a resolver, a route, a parent that read the flag).
 *
 * Before the SDK is ready it waits for the first datafile and records then.
 * If this element is destroyed while waiting, nothing is recorded: the
 * visitor never saw the decision.
 */
@Directive({ selector: '[avsbExposure]', standalone: true })
export class AvsbExposureDirective implements OnInit, OnChanges, OnDestroy {
  /** The flag key whose decision this element shows. */
  @Input({ required: true }) avsbExposure!: AvsbFlagKey

  /**
   * The default value the surrounding read used. Recording an exposure needs
   * a default because it completes a normal read, but the value is discarded:
   * a flag with no decision behind it records nothing either way.
   */
  @Input() avsbExposureDefault: unknown = null

  private readonly _service = inject(AvsbService)
  private _cancel: (() => void) | null = null
  private _started = false

  ngOnInit(): void {
    this._started = true
    this._record()
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this._started) return
    if (changes['avsbExposure'] === undefined) return
    // A different flag on the same element is a different decision.
    this._record()
  }

  ngOnDestroy(): void {
    this._cancel?.()
    this._cancel = null
  }

  private _record(): void {
    this._cancel?.()
    this._cancel = this._service.recordExposure(
      this.avsbExposure,
      this.avsbExposureDefault
    )
  }
}
