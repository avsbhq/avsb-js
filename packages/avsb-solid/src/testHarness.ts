/**
 * Harness for this package's own tests. Not part of any entry point and not
 * published (`files` ships `dist` and `src`, but nothing imports this).
 *
 * Accessors are run inside a `createRoot` whose owner carries the Avsb
 * context, so the real accessors run with no component, no JSX, and no DOM.
 * `Owner.context` and `Context.id` are both part of solid-js's public type
 * surface, which is what makes this legitimate rather than a hack: it is the
 * same lookup `<AvsbContext.Provider>` performs.
 *
 * Solid runs effects at the end of the enclosing update, so read values
 * AFTER `runWithAvsbContext` returns, not inside the callback.
 */
import { createRoot, getOwner, type Owner } from 'solid-js'
import { AvsbContext, type AvsbContextValue } from './context'

export interface RunResult<T> {
  result: T
  dispose: () => void
}

export function runWithAvsbContext<T>(
  value: AvsbContextValue,
  run: () => T
): RunResult<T> {
  let result: T | undefined
  let dispose: () => void = () => {}

  createRoot((disposeRoot) => {
    dispose = disposeRoot

    const owner: Owner | null = getOwner()
    if (owner) {
      owner.context = { ...(owner.context ?? {}), [AvsbContext.id]: value }
    }

    result = run()
  })

  return { result: result as T, dispose }
}
