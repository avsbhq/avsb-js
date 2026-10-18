import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import React from 'react'
import { AvsbContext } from './context'
import type { AvsbContextValue } from './context'
import { useIdentify } from './useIdentify'
import { useAlias } from './useAlias'
import { useReset } from './useReset'
import type { EvalContext } from '@avsbhq/core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockClient() {
  return {
    identify: vi.fn(),
    alias: vi.fn(() => Promise.resolve()),
    reset: vi.fn(),
    onReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(() => () => {}),
    close: vi.fn(() => Promise.resolve()),
    subscribe: vi.fn((_key: string, _cb: () => void) => () => {}),
    getSnapshot: vi.fn(),
    track: vi.fn(),
  }
}

function wrap(ctx: AvsbContextValue, children: React.ReactNode) {
  return (
    <AvsbContext.Provider value={ctx}>
      {children}
    </AvsbContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Tests: useIdentify
// ---------------------------------------------------------------------------

describe('useIdentify', () => {
  function IdentifyButton({ ctx }: { ctx: EvalContext }) {
    const identify = useIdentify()
    return (
      <button onClick={() => identify(ctx)}>identify</button>
    )
  }

  it('calls client.identify with the provided context', async () => {
    const client = makeMockClient()
    const ctx: EvalContext = { kind: 'user', key: 'u_123', email: 'user@test.com' }

    render(
      wrap(
        { client: client as never, status: 'ready' },
        <IdentifyButton ctx={ctx} />
      )
    )

    await act(async () => {
      screen.getByText('identify').click()
    })

    expect(client.identify).toHaveBeenCalledOnce()
    expect(client.identify).toHaveBeenCalledWith(ctx)
  })

  it('is a no-op when client is null', async () => {
    // Should not throw even with null client
    function SafeIdentify() {
      const identify = useIdentify()
      identify({ kind: 'user', key: 'x' }) // called during render — must be safe
      return <span>ok</span>
    }

    expect(() =>
      render(
        wrap(
          { client: null, status: 'loading' },
          <SafeIdentify />
        )
      )
    ).not.toThrow()
  })

  it('returns a stable function reference across renders', () => {
    const client = makeMockClient()
    const refs: Array<(ctx: EvalContext) => void> = []

    function Inspector() {
      const identify = useIdentify()
      refs.push(identify)
      return <span>{refs.length}</span>
    }

    const { rerender } = render(
      wrap(
        { client: client as never, status: 'ready' },
        <Inspector />
      )
    )

    rerender(
      wrap(
        { client: client as never, status: 'ready' },
        <Inspector />
      )
    )

    expect(refs.length).toBeGreaterThanOrEqual(2)
    expect(refs[0]).toBe(refs[refs.length - 1]) // same reference
  })
})

// ---------------------------------------------------------------------------
// Tests: useAlias
// ---------------------------------------------------------------------------

describe('useAlias', () => {
  function AliasButton({
    prev,
    next,
  }: {
    prev: EvalContext
    next: EvalContext
  }) {
    const alias = useAlias()
    return (
      <button onClick={() => alias(prev, next)}>alias</button>
    )
  }

  it('calls client.alias with prev and next contexts', async () => {
    const client = makeMockClient()
    const prev: EvalContext = { kind: 'user', key: 'anon_xyz' }
    const next: EvalContext = { kind: 'user', key: 'u_456' }

    render(
      wrap(
        { client: client as never, status: 'ready' },
        <AliasButton prev={prev} next={next} />
      )
    )

    await act(async () => {
      screen.getByText('alias').click()
    })

    expect(client.alias).toHaveBeenCalledOnce()
    expect(client.alias).toHaveBeenCalledWith(prev, next)
  })

  it('resolves the returned promise from client.alias', async () => {
    const client = makeMockClient()
    let promiseResolved = false

    function AliasInspector() {
      const alias = useAlias()
      const run = async () => {
        await alias({ kind: 'user', key: 'a' }, { kind: 'user', key: 'b' })
        promiseResolved = true
      }
      return <button onClick={run}>go</button>
    }

    render(
      wrap(
        { client: client as never, status: 'ready' },
        <AliasInspector />
      )
    )

    await act(async () => {
      screen.getByText('go').click()
    })

    expect(promiseResolved).toBe(true)
  })

  it('is a no-op when client is null', async () => {
    function SafeAlias() {
      const alias = useAlias()
      alias({ kind: 'user', key: 'x' }, { kind: 'user', key: 'y' }).catch(() => {})
      return <span>ok</span>
    }

    expect(() =>
      render(
        wrap(
          { client: null, status: 'loading' },
          <SafeAlias />
        )
      )
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Tests: useReset
// ---------------------------------------------------------------------------

describe('useReset', () => {
  function ResetButton() {
    const reset = useReset()
    return <button onClick={reset}>reset</button>
  }

  it('calls client.reset on invoke', async () => {
    const client = makeMockClient()

    render(
      wrap(
        { client: client as never, status: 'ready' },
        <ResetButton />
      )
    )

    await act(async () => {
      screen.getByText('reset').click()
    })

    expect(client.reset).toHaveBeenCalledOnce()
  })

  it('is a no-op when client is null', async () => {
    function SafeReset() {
      const reset = useReset()
      reset()
      return <span>ok</span>
    }

    expect(() =>
      render(
        wrap(
          { client: null, status: 'loading' },
          <SafeReset />
        )
      )
    ).not.toThrow()
  })

  it('returns a stable function reference', () => {
    const client = makeMockClient()
    const refs: Array<() => void> = []

    function Inspector() {
      const reset = useReset()
      refs.push(reset)
      return <span>{refs.length}</span>
    }

    const { rerender } = render(
      wrap(
        { client: client as never, status: 'ready' },
        <Inspector />
      )
    )

    rerender(
      wrap(
        { client: client as never, status: 'ready' },
        <Inspector />
      )
    )

    expect(refs.length).toBeGreaterThanOrEqual(2)
    expect(refs[0]).toBe(refs[refs.length - 1])
  })
})
