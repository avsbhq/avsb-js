import { Directive, Input, TemplateRef, ViewContainerRef, inject } from '@angular/core'
import type { OnChanges, OnDestroy, OnInit, SimpleChanges } from '@angular/core'
import type { Subscription } from 'rxjs'
import type { AvsbFlagKey, Flag } from '@avsbhq/core'
import { AvsbService } from './avsb.service'
import { misuseLogger } from './internal/logger'
import { bothMatchersMessage } from './internal/messages'

/**
 * Render a block of template based on one flag.
 *
 * ```html
 * <!-- the flag is on for this visitor -->
 * <section *avsbFlag="'new-dashboard'">...</section>
 *
 * <!-- with a fallback branch -->
 * <section *avsbFlag="'new-dashboard'; else legacyDashboard">...</section>
 * <ng-template #legacyDashboard>...</ng-template>
 *
 * <!-- a specific variation of a multivariate flag, by variation key -->
 * <section *avsbFlag="'hero'; default: 'control'; whenVariation: 'variant-a'">
 *   ...
 * </section>
 *
 * <!-- or by the value that variation carries -->
 * <section *avsbFlag="'hero'; default: 'control'; whenValue: 'blue'">...</section>
 * ```
 *
 * The read is exposure-free, because a render is not a decision. Add
 * `exposure: true` (or put `[avsbExposure]` on an element inside) to record
 * that the visitor was shown this branch.
 */
@Directive({ selector: '[avsbFlag]', standalone: true })
export class AvsbFlagDirective implements OnInit, OnChanges, OnDestroy {
  /** The flag key to read. */
  @Input({ required: true }) avsbFlag!: AvsbFlagKey

  /**
   * The value to use until the datafile arrives, and whenever the flag is
   * missing. Defaults to `false`, which suits the plain on/off case.
   */
  @Input() avsbFlagDefault: unknown = false

  /**
   * Render only when the served variation has this key, as shown in the
   * dashboard (`'control'`, `'variant-a'`).
   *
   * This is the multivariate gate. It compares `Flag.variationKey`, never
   * the value: two variations can carry the same value.
   */
  @Input() avsbFlagWhenVariation?: string

  /**
   * Render only when the flag's value equals this, compared with `Object.is`.
   *
   * `undefined` means "not in use". A datafile can only carry JSON, so no
   * real flag value is ever `undefined`, and `null` compares normally.
   */
  @Input() avsbFlagWhenValue?: unknown

  /**
   * Rendered instead when the condition is false. Bound by the `else`
   * microsyntax, exactly like `*ngIf`.
   */
  @Input() avsbFlagElse: TemplateRef<unknown> | null = null

  /**
   * Record an exposure the first time this branch is shown. Default `false`:
   * reads stay exposure-free unless you say otherwise.
   */
  @Input() avsbFlagExposure = false

  private readonly _templateRef = inject(TemplateRef<unknown>)
  private readonly _viewContainer = inject(ViewContainerRef)
  private readonly _service = inject(AvsbService)

  private _subscription: Subscription | null = null
  private _shownTemplate: TemplateRef<unknown> | null = null
  private _exposureRecorded = false
  private _cancelExposure: (() => void) | null = null

  ngOnInit(): void {
    this._warnOnDoubleMatcher()
    this._subscribe()
  }

  ngOnChanges(changes: SimpleChanges): void {
    // Only re-subscribe once ngOnInit has run: Angular sets the inputs
    // before the first ngOnInit, and subscribing twice at startup would
    // double the work for no reason.
    if (this._subscription === null) return

    if (
      changes['avsbFlag'] !== undefined ||
      changes['avsbFlagDefault'] !== undefined
    ) {
      // A different key or default is a different flag read: the exposure
      // for the new one has not happened yet.
      this._exposureRecorded = false
      this._warnOnDoubleMatcher()
      this._subscribe()
      return
    }

    if (
      changes['avsbFlagWhenVariation'] !== undefined ||
      changes['avsbFlagWhenValue'] !== undefined ||
      changes['avsbFlagElse'] !== undefined
    ) {
      // Same flag, different condition: re-evaluate against the value we
      // already hold rather than re-reading the client.
      this._warnOnDoubleMatcher()
      this._render(this._service.snapshot(this.avsbFlag, this.avsbFlagDefault))
    }
  }

  ngOnDestroy(): void {
    this._subscription?.unsubscribe()
    this._subscription = null
    this._cancelExposure?.()
    this._cancelExposure = null
    this._viewContainer.clear()
    this._shownTemplate = null
  }

  private _subscribe(): void {
    this._subscription?.unsubscribe()
    this._subscription = this._service
      .getFlag(this.avsbFlag, this.avsbFlagDefault)
      .subscribe((flag: Flag<unknown>) => {
        this._render(flag)
      })
  }

  /** Decide which template (if any) belongs on screen for this value. */
  private _shouldShow(flag: Flag<unknown>): boolean {
    const wantsVariation = this.avsbFlagWhenVariation !== undefined
    const wantsValue = this.avsbFlagWhenValue !== undefined

    if (wantsVariation && flag.variationKey !== this.avsbFlagWhenVariation) {
      return false
    }
    if (wantsValue && !Object.is(flag.value, this.avsbFlagWhenValue)) {
      return false
    }
    if (wantsVariation || wantsValue) return true

    return flag.isEnabled()
  }

  private _render(flag: Flag<unknown>): void {
    const show = this._shouldShow(flag)
    const next = show ? this._templateRef : this.avsbFlagElse
    this._applyView(next)

    if (show && this.avsbFlagExposure && !this._exposureRecorded) {
      // Only reachable for a key this directive has not recorded yet, so
      // this cancels a still-pending exposure for the PREVIOUS key: that
      // branch is off screen now and must not be counted.
      this._cancelExposure?.()
      this._exposureRecorded = true
      this._cancelExposure = this._service.recordExposure(
        this.avsbFlag,
        this.avsbFlagDefault
      )
    }
  }

  private _applyView(next: TemplateRef<unknown> | null): void {
    if (next === this._shownTemplate) return
    this._viewContainer.clear()
    this._shownTemplate = next
    if (next !== null) this._viewContainer.createEmbeddedView(next)
  }

  private _warnOnDoubleMatcher(): void {
    if (
      this.avsbFlagWhenVariation !== undefined &&
      this.avsbFlagWhenValue !== undefined
    ) {
      misuseLogger.warn(bothMatchersMessage(this.avsbFlag))
    }
  }
}
