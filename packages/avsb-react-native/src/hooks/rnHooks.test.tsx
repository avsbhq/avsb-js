import { describe, it, expect } from 'vitest'
import * as rnHooks from './rnHooks'

// ---------------------------------------------------------------------------
// rnHooks — smoke tests verifying all re-exported hooks are functions.
//
// The underlying behaviour of each hook is tested in @avsbhq/react. These
// tests verify the re-export barrel is correctly wired so consumers of
// @avsbhq/react-native get the expected surface.
// ---------------------------------------------------------------------------

describe('rnHooks — re-exported hooks are functions', () => {
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

  it('exports the expected number of hooks', () => {
    const exportedNames = Object.keys(rnHooks)
    expect(exportedNames.length).toBe(expectedHooks.length)
  })

  it('exports all required hook names', () => {
    for (const hookName of expectedHooks) {
      expect(rnHooks).toHaveProperty(hookName)
    }
  })

  it.each(expectedHooks)('%s is a function', (hookName) => {
    expect(typeof rnHooks[hookName]).toBe('function')
  })
})
