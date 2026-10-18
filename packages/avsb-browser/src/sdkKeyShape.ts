// =====================================================================
// SDK key shape validation at construction (spec §1.2).
//
// The implementation lives ONCE, in `@avsbhq/utils/sdkKey`, so the browser
// SDK and the server SDK say exactly the same thing about exactly the same
// key. This file re-exports it and keeps the import path this package's own
// modules and tests already use.
//
// `@avsbhq/utils/sdkKey` is a zero-dependency leaf subpath: importing it does
// not pull the utils root chunk into a browser bundle.
// =====================================================================

export {
  validateSdkKeyShape,
  describeSdkKey,
  SDK_KEY_PATTERN,
} from '@avsbhq/utils/sdkKey'
export type { SdkKeyShapeResult } from '@avsbhq/utils/sdkKey'
