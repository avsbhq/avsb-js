// Re-exports of hooks from @avsbhq/react that are compatible with React Native.
//
// React Native uses the same React hook model as React web; every hook
// exported from @avsbhq/react works on RN as long as the rendering engine
// and event loop behave correctly, which they do on RN ≥ 0.74 (New
// Architecture / Hermes).
//
// Hooks that reference DOM-specific APIs (e.g. EventSource, localStorage)
// live inside @avsbhq/browser, not in the hook layer — so there is no
// web-only surface to exclude here.

export {
  // Flag reads — rendering (useSyncExternalStore)
  useFlag,
  useFlagValue,
  useBoolFlag,
  useStringFlag,
  useNumberFlag,
  useJsonFlag,
  useAllFlags,
  // Flag hooks — Suspense
  useFlagSuspense,
  // Flag hooks — side-effect (non-rendering)
  useFlagChange,
  useFlagSubscription,
  useExposure,
  // Status hooks
  useAvsbStatus,
  useFlagReady,
  // Client hooks
  useAvsbClient,
  useAvsbClientSuspense,
  // Identity hooks
  useIdentify,
  useAlias,
  useReset,
  // Tracking
  useTrack,
} from '@avsbhq/react'
