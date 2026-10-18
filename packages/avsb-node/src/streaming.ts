// SSE streaming client for A vs B server SDK.
//
// The implementation has moved to `@avsbhq/utils/streaming` so it can be
// shared with `@avsbhq/browser`. This file re-exports everything so all
// existing AvsbServer imports (`from './streaming'`) keep working unchanged.
export {
  createStreamingClient,
  createBrowserStreamingClient,
} from '@avsbhq/utils/streaming'
export type { StreamingClient, StreamingOptions } from '@avsbhq/utils/streaming'
