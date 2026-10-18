import { describe, it, expect } from 'vitest'
import { AvsbProvider, type AvsbRNProviderProps } from './AvsbProvider'

// ---------------------------------------------------------------------------
// AvsbProvider — structural / contract tests.
//
// The vitest config uses environment: 'node', so this file tests the
// structural contract of the component (function shape, prop types). The
// lifecycle (client ownership, close on unmount, options, heartbeat identity)
// is in AvsbProvider.lifecycle.test.tsx, which opts into happy-dom.
// ---------------------------------------------------------------------------

describe('AvsbProvider — structural contract', () => {
  it('is exported as a function', () => {
    expect(typeof AvsbProvider).toBe('function')
  })

  it('has the expected function name', () => {
    expect(AvsbProvider.name).toBe('AvsbProvider')
  })

  it('accepts the expected props shape (TypeScript structural check)', () => {
    // The props type accepts sdkKey + optional context + optional storage + children.
    // We verify at the type level by constructing a valid props object.
    const props: AvsbRNProviderProps = {
      sdkKey: 'sdk-key-test',
      children: null,
    }
    expect(props.sdkKey).toBe('sdk-key-test')
  })

  it('accepts a storage prop that satisfies AsyncStorageLike', () => {
    const mockStorage = {
      getItem: async (_key: string) => null,
      setItem: async (_key: string, _value: string) => {},
      removeItem: async (_key: string) => {},
    }
    const props: AvsbRNProviderProps = {
      sdkKey: 'sdk-key-2',
      storage: mockStorage,
      children: null,
    }
    expect(props.storage).toBe(mockStorage)
  })

  it('accepts a context prop of AvsbClientOptions context shape', () => {
    const props: AvsbRNProviderProps = {
      sdkKey: 'sdk-key-3',
      context: { kind: 'user', key: 'user-123' },
      children: null,
    }
    expect(props.context).toEqual({ kind: 'user', key: 'user-123' })
  })

  /**
   * The props the README and the docs already pass. Before the passthrough this
   * object did not typecheck, so every published React Native example was wrong
   * the day it shipped. This file runs in the node environment and checks the
   * prop contract rather than rendering, which is exactly what the gap was.
   */
  it('accepts the client options the docs pass: bootstrap, onError, logger', () => {
    const onError = (_error: Error): void => undefined
    const props: AvsbRNProviderProps = {
      sdkKey: 'sdk_production_reactnative01',
      bootstrap: {
        version: 2,
        projectType: 'FEATURE_FLAG',
        sdkKey: 'sdk_production_reactnative01',
        environmentKey: 'production',
        publishedAt: '2026-01-01T00:00:00.000Z',
        collectEndpoint: 'https://collect.test.invalid',
        audiences: [],
        flags: [],
      },
      onError,
      logLevel: 'silent',
      autoRefresh: false,
      children: null,
    }

    expect(props.bootstrap?.environmentKey).toBe('production')
    expect(props.onError).toBe(onError)
    expect(props.autoRefresh).toBe(false)
    expect(props.logLevel).toBe('silent')
  })
})
