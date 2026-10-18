import { ElementRef, TemplateRef } from '@angular/core'
import type { EmbeddedViewRef } from '@angular/core'

/**
 * A `TemplateRef` that only has to be distinguishable by identity: the
 * directive under test hands it to the view container, and the fake view
 * container records which one it received.
 */
export class FakeTemplateRef extends TemplateRef<unknown> {
  override readonly elementRef = new ElementRef(document.createElement('div'))

  constructor(readonly label: string) {
    super()
  }

  override createEmbeddedView(): EmbeddedViewRef<unknown> {
    throw new Error(
      `FakeTemplateRef(${this.label}) was rendered directly; the view ` +
        'container is the thing under test.'
    )
  }
}

/**
 * A `ViewContainerRef` stand-in recording what the directive rendered.
 * Supplied through `useValue`, so it does not need the ~15 members of the
 * real abstract class.
 */
export class FakeViewContainerRef {
  readonly created: TemplateRef<unknown>[] = []
  clearCount = 0
  private _current: TemplateRef<unknown> | null = null

  createEmbeddedView(templateRef: TemplateRef<unknown>): void {
    this.created.push(templateRef)
    this._current = templateRef
  }

  clear(): void {
    this.clearCount += 1
    this._current = null
  }

  /** The template currently on screen, or null. */
  get rendered(): TemplateRef<unknown> | null {
    return this._current
  }
}

/** A `ChangeDetectorRef` stand-in that counts `markForCheck()` calls. */
export class FakeChangeDetectorRef {
  markForCheckCount = 0

  markForCheck(): void {
    this.markForCheckCount += 1
  }

  detectChanges(): void {}
  checkNoChanges(): void {}
  detach(): void {}
  reattach(): void {}
}
