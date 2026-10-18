import { describe, it, expect, vi } from 'vitest'
import { createEventBus } from './eventBus'
import type { InitResult } from './types'

describe('createEventBus', () => {
  it('fans an emission out to every subscriber', () => {
    const bus = createEventBus()
    const a = vi.fn()
    const b = vi.fn()
    bus.on('error', a)
    bus.on('error', b)
    bus.emit('error', new Error('boom'))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('on() returns an unsubscribe that removes the listener', () => {
    const bus = createEventBus()
    const cb = vi.fn()
    const unsub = bus.on('error', cb)
    unsub()
    bus.emit('error', new Error('after-unsub'))
    expect(cb).not.toHaveBeenCalled()
  })

  it('off() removes a specific listener without affecting siblings', () => {
    const bus = createEventBus()
    const a = vi.fn()
    const b = vi.fn()
    bus.on('error', a)
    bus.on('error', b)
    bus.off('error', a)
    bus.emit('error', new Error('x'))
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalled()
  })

  it('listener errors do not stop later listeners and surface to onListenerError', () => {
    const onListenerError = vi.fn()
    const bus = createEventBus(onListenerError)
    const second = vi.fn()
    bus.on('error', () => {
      throw new Error('first listener blew up')
    })
    bus.on('error', second)
    bus.emit('error', new Error('event'))
    expect(second).toHaveBeenCalled()
    expect(onListenerError).toHaveBeenCalledWith(
      'error',
      expect.any(Error)
    )
  })

  it('emits typed event payloads — ready receives an InitResult', () => {
    const bus = createEventBus()
    const cb = vi.fn()
    bus.on('ready', cb)
    const result: InitResult = { success: true, source: 'network' }
    bus.emit('ready', result)
    expect(cb).toHaveBeenCalledWith(result)
  })

  it('returns silently when no listeners are registered for an event', () => {
    const bus = createEventBus()
    expect(() => bus.emit('error', new Error('nothing-attached'))).not.toThrow()
  })
})
