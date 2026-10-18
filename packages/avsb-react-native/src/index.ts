// -----------------------------------------------------------------------
// @avsbhq/react-native — public surface.
//
// React Native flavour of the AvsB SDK. Wraps @avsbhq/browser and
// @avsbhq/react with AsyncStorage-backed persistence and RN-compatible
// provider wiring.
// -----------------------------------------------------------------------

// Provider
export { AvsbProvider } from './AvsbProvider'
export type { AvsbRNProviderProps } from './AvsbProvider'

// Storage adapter
export { createAsyncStorageAdapter, warmFromStorage } from './asyncStorageCache'
export type {
  AsyncStorageLike,
  AsyncStorageAdapterOptions,
  AsyncStorageWithKeys,
} from './asyncStorageCache'

// Hooks — re-exported from @avsbhq/react
export * from './hooks/rnHooks'
