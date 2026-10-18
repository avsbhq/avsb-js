import { describe, expect, it, vi } from 'vitest'
import { noopLogger } from '@avsbhq/core'
import { createGuarded } from './guardedPromise'

const flush = () => new Promise<void>((r) => queueMicrotask(r))

describe('createGuarded', () => {
  it('resolves consumers awaiting the thenable', async () => {
    const ctrl = createGuarded<number>(noopLogger, () => 'test')
    ctrl.resolve(42)
    expect(await ctrl.thenable).toBe(42)
  })

  it('handler attached via .catch() suppresses the root warn', async () => {
    const log = { ...noopLogger, warn: vi.fn() }
    const ctrl = createGuarded<number>(log, () => 'test')
    const caught = vi.fn()
    ctrl.thenable.catch(caught)
    ctrl.reject(new Error('boom'))
    await flush()
    await flush()
    expect(caught).toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('rejection with no handler logs once via the logger', async () => {
    const log = { ...noopLogger, warn: vi.fn() }
    const ctrl = createGuarded<number>(log, () => 'test')
    ctrl.reject(new Error('boom'))
    await flush()
    await flush()
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('stop() leaves the promise pending forever, no fire, no log', async () => {
    const log = { ...noopLogger, warn: vi.fn() }
    const ctrl = createGuarded<number>(log, () => 'test')
    let resolved = false
    ctrl.thenable.then(() => {
      resolved = true
    })
    ctrl.thenable.stop()
    ctrl.resolve(1)
    ctrl.reject(new Error('boom'))
    await flush()
    await flush()
    expect(resolved).toBe(false)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('stop() runs the engine teardown', () => {
    const ctrl = createGuarded<void>(noopLogger, () => 'test')
    const teardown = vi.fn()
    ctrl.onStop(teardown)
    ctrl.thenable.stop()
    expect(teardown).toHaveBeenCalledOnce()
  })
})
