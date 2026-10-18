// -----------------------------------------------------------------------
// @avsbhq/react/testing — the test surface.
//
// Kept out of the main entry so a production bundle never pulls the
// datafile builder in.
// -----------------------------------------------------------------------

export { AvsbTestProvider, createTestClient } from './testing/AvsbTestProvider'
export type { AvsbTestProviderProps } from './testing/AvsbTestProvider'

export { createTestDatafile } from './testing/createTestDatafile'
export type {
  TestFlags,
  TestFlagValue,
  CreateTestDatafileOptions,
} from './testing/createTestDatafile'
