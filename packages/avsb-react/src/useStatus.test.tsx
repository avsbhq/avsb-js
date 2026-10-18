/**
 * The status machine, as a pure function.
 *
 * These are the rules the provider follows, tested without a React tree so
 * each one is a single readable case. The wiring (which client events call
 * this, and when) is tested in AvsbProvider.test.tsx.
 */
import { describe, it, expect } from 'vitest'
import type { InitResult } from '@avsbhq/core'
import { deriveStatus, sameStatus } from './providerStatus'

const failure = new Error(
  'the datafile request failed with 404 for https://cdn.avsb.cloud/sdk_x/datafile.json',
)
const refreshFailure = new Error('refresh failed (503)')

describe('deriveStatus', () => {
  it('is loading while nothing is readable and nothing has settled', () => {
    expect(deriveStatus({ readable: false, initResult: null })).toEqual({
      status: 'loading',
      degraded: false,
      error: undefined,
    })
  })

  it('is ready as soon as flags are readable, even before init settles', () => {
    // Cache-then-network: a cached datafile is readable while the refresh
    // is still in flight.
    expect(deriveStatus({ readable: true, initResult: null })).toEqual({
      status: 'ready',
      degraded: false,
      error: undefined,
    })
  })

  it('is ready for a successful init', () => {
    const initResult: InitResult = { success: true, source: 'network' }
    expect(deriveStatus({ readable: true, initResult })).toEqual({
      status: 'ready',
      degraded: false,
      error: undefined,
    })
  })

  it('treats a degraded init as ready-with-warning, never as an error', () => {
    // The exact shape the browser client resolves when a cached datafile is
    // served after a failed refresh. It ALSO emits an 'error' event, and
    // reading that as fatal is the trap this rule closes.
    const initResult: InitResult = {
      success: true,
      degraded: true,
      source: 'error',
      error: refreshFailure,
    }

    expect(deriveStatus({ readable: true, initResult })).toEqual({
      status: 'ready',
      degraded: true,
      error: refreshFailure,
    })
  })

  it('is degraded when a refresh failed after a healthy init', () => {
    // The client settles once, so a later poll failure never reaches
    // initResult: the error event is the only signal.
    const initResult: InitResult = { success: true, source: 'network' }

    expect(deriveStatus({ readable: true, initResult, lastError: refreshFailure })).toEqual({
      status: 'ready',
      degraded: true,
      error: refreshFailure,
    })
  })

  it('is error only when the init settled with nothing to serve', () => {
    const initResult: InitResult = { success: false, source: 'error', error: failure }

    expect(deriveStatus({ readable: false, initResult })).toEqual({
      status: 'error',
      degraded: false,
      error: failure,
    })
  })

  it('carries an error seen while still loading without giving up', () => {
    // A poll failed before anything was readable. A later poll can still
    // rescue it, so this is not terminal.
    expect(deriveStatus({ readable: false, initResult: null, lastError: failure })).toEqual({
      status: 'loading',
      degraded: false,
      error: failure,
    })
  })

  it('prefers a readable client over a stale failure', () => {
    const initResult: InitResult = { success: false, source: 'error', error: failure }

    // A later poll made flags readable; the old failure must not pin the
    // app on an error screen.
    expect(deriveStatus({ readable: true, initResult }).status).toBe('ready')
  })

  it('falls back to the event error when the result carries none', () => {
    const initResult: InitResult = { success: false, source: 'error' }

    expect(deriveStatus({ readable: false, initResult, lastError: failure }).error).toBe(failure)
  })
})

describe('sameStatus', () => {
  it('is true for two states that would render identically', () => {
    expect(
      sameStatus(
        { status: 'ready', degraded: false },
        { status: 'ready', degraded: false, error: undefined },
      ),
    ).toBe(true)
  })

  it('is false when the warning appears', () => {
    expect(
      sameStatus({ status: 'ready', degraded: false }, { status: 'ready', degraded: true }),
    ).toBe(false)
  })

  it('is false when the error object changes', () => {
    expect(
      sameStatus(
        { status: 'error', degraded: false, error: failure },
        { status: 'error', degraded: false, error: refreshFailure },
      ),
    ).toBe(false)
  })
})
