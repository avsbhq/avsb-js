// =====================================================================
// Browser-safe snapshot leaf: `@avsbhq/utils/snapshot`.
//
// `createSnapshotStore` is the only part of the snapshot/bootstrap surface a
// browser client needs at runtime, and `snapshotStore.ts` depends on nothing
// but `@avsbhq/core`. It gets its own subpath for the same reason `./backoff`,
// `./sdkKey` and `./exposure` have theirs: the ROOT barrel is deliberately
// node-side (request scoping via `node:async_hooks`, the warehouse decision
// sinks, file bootstrap) and cannot be resolved by a browser bundler at all.
//
// The browser package used to reach `createSnapshotStore` through the root,
// which meant every customer bundling `@avsbhq/browser` for the web hit
// "Could not resolve fs/promises" and "Could not resolve async_hooks". Nothing
// in this file may import the root barrel, and nothing here may import a
// module that touches a node builtin.
//
// The type re-exports are `export type`, so they erase at build time and cost
// the bundle nothing.
// =====================================================================

export { createSnapshotStore, snapshotReason } from './snapshotStore'
export type { SnapshotStore } from './snapshotStore'
export type {
  BootstrapBlob,
  FlagSnapshot,
  HydrateBootstrapResult,
} from './snapshots'
