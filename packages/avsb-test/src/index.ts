export { createMockClient, type MockClient, type MockClientOptions } from './createMockClient';

// Server-shaped mock with `forUser`, for code that takes an AvsbServer.
export {
  createMockServer,
  type MockServer,
  type MockServerOptions,
  type MockBoundClient,
  type MockPurchaseOrder,
} from './createMockServer';

// `AvsbTestProvider` is deliberately NOT here. It imports React, and a root
// barrel that imports React cannot be loaded AT ALL by a Vue, Svelte, or
// plain-Node project, which is most of what installs this package. It lives
// on `@avsbhq/test/react`.
//
// `resolveTestClient` is the provider's precedence rule and touches no React,
// so it stays reachable from here for anyone writing their own wrapper.
export { resolveTestClient, type TestClientProps } from './resolveTestClient';

export { TestData, type TestDataEntry } from './TestData';

// The bridge that makes TestData usable with either mock.
export {
  flagsFromTestData,
  createMockFlagResolver,
  type MockFlagState,
  type MockFlagResolver,
} from './mockFlags';

export {
  recordEvaluations,
  type Recorder,
  type RecorderMatcher,
  type TrackMatcher,
  type EvaluationRecord,
} from './recordEvaluations';

// Fixture builders and the real-client helper. They also ship on the
// framework-neutral `@avsbhq/test/fixtures` subpath, which is what the
// framework adapters re-export so a Vue or Svelte tarball never inlines this
// package's React provider.
export {
  createTestDatafile,
  TEST_SDK_KEY,
  type TestFlags,
  type TestFlagValue,
  type CreateTestDatafileOptions,
} from './fixtures/datafile';

export { createTestContext, createMultiTestContext } from './fixtures/context';

export { createTestClient, type TestClientOptions } from './createTestClient';
// Core types these signatures reference. Re-exported so a consumer can NAME what
// this package hands back (`Flag`, its `source`/`ruleType` members, the context
// it takes) from the same import path, instead of being told to install
// @avsbhq/core to write a variable annotation.
export type {
  Flag,
  RuleType,
  EvaluationSource,
  EvalContext,
  SingleContext,
  MultiContext,
  InitResult,
  TrackPayload,
  DecisionLog,
  FlagDatafile,
} from '@avsbhq/core';
