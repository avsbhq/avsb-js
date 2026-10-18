import { describe, it, expect } from 'vitest'
import * as barrel from './index'

// ---------------------------------------------------------------------------
// index barrel — smoke tests verifying the public surface is correctly wired.
//
// Checks that every named export the package advertises is present and has
// the correct JavaScript typeof value (function for components + hooks +
// factories, undefined would indicate a broken re-export).
// ---------------------------------------------------------------------------

describe('index barrel — public exports present', () => {
  it('exports AvsbProvider as a function', () => {
    expect(typeof barrel.AvsbProvider).toBe('function')
  })

  it('exports createAsyncStorageAdapter as a function', () => {
    expect(typeof barrel.createAsyncStorageAdapter).toBe('function')
  })

  it('exports warmFromStorage as a function', () => {
    expect(typeof barrel.warmFromStorage).toBe('function')
  })

  it('exports all hook functions from rnHooks', () => {
    const expectedHooks = [
      'useFlag',
      'useFlagValue',
      'useFlagChange',
      'useFlagSubscription',
      'useFlagReady',
      'useFlagSuspense',
      'useBoolFlag',
      'useStringFlag',
      'useNumberFlag',
      'useJsonFlag',
      'useAllFlags',
      'useExposure',
      'useAvsbClient',
      'useAvsbClientSuspense',
      'useAvsbStatus',
      'useIdentify',
      'useAlias',
      'useReset',
      'useTrack',
    ] as const

    for (const hookName of expectedHooks) {
      expect(
        typeof (barrel as Record<string, unknown>)[hookName],
        `${hookName} should be a function`
      ).toBe('function')
    }
  })

  it('does not export unexpected names that would widen the public surface accidentally', () => {
    // Listing the expected public names acts as a guard against accidental
    // wildcard re-exports leaking internals.
    const knownPublicNames = new Set([
      'AvsbProvider',
      'createAsyncStorageAdapter',
      'warmFromStorage',
      // hooks from rnHooks
      'useFlag',
      'useFlagValue',
      'useFlagChange',
      'useFlagSubscription',
      'useFlagReady',
      'useFlagSuspense',
      'useBoolFlag',
      'useStringFlag',
      'useNumberFlag',
      'useJsonFlag',
      'useAllFlags',
      'useExposure',
      'useAvsbClient',
      'useAvsbClientSuspense',
      'useAvsbStatus',
      'useIdentify',
      'useAlias',
      'useReset',
      'useTrack',
    ])

    const exported = Object.keys(barrel)
    for (const name of exported) {
      expect(
        knownPublicNames.has(name),
        `unexpected export: ${name}`
      ).toBe(true)
    }
  })
})
