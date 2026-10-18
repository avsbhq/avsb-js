import { describe, expect, it, vi } from 'vitest'
import { createRegistry } from './registry'

describe('createRegistry', () => {
  it('runs every registered teardown on drain()', () => {
    const reg = createRegistry()
    const a = vi.fn()
    const b = vi.fn()
    reg.add(a)
    reg.add(b)
    reg.drain()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('add() returns a disposer that runs the teardown once', () => {
    const reg = createRegistry()
    const fn = vi.fn()
    const dispose = reg.add(fn)
    dispose()
    dispose()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(reg.size()).toBe(0)
  })

  it('throwing teardowns do not strand the rest', () => {
    const reg = createRegistry()
    const a = vi.fn(() => {
      throw new Error('boom')
    })
    const b = vi.fn()
    reg.add(a)
    reg.add(b)
    reg.drain()
    expect(a).toHaveBeenCalled()
    expect(b).toHaveBeenCalled()
  })

  it('drain() empties the registry', () => {
    const reg = createRegistry()
    reg.add(() => undefined)
    reg.add(() => undefined)
    expect(reg.size()).toBe(2)
    reg.drain()
    expect(reg.size()).toBe(0)
  })
})
