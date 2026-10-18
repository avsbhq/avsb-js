// Prop resolution for `AvsbTestProvider`, kept out of the component so the
// precedence rule is testable without rendering anything.
//
// Breaking change B26: the provider's props are `{ flags, context, client }`,
// matching the reference wrappers in @avsbhq/vue, @avsbhq/svelte and
// @avsbhq/solid so one shape is learned once. Four READMEs used to teach
// `<AvsbTestProvider mockFlags={{ 'new-checkout': true }}>`, a prop that
// never existed, because the real one-liner (`options={{ flags: {...} }}`)
// is the shape nobody guesses. The map IS the common case, so it is a prop.

import { createMockClient } from './createMockClient';
import type { MockClient, MockClientOptions } from './mockClientTypes';
import type { EvalContext } from '@avsbhq/core';

export interface TestClientProps {
  /** A pre-built client. Wins over everything else. */
  client?: MockClient;
  /** Full mock options. Wins over `flags` and `context`. */
  options?: MockClientOptions;
  /** Shorthand for `options={{ flags }}`: flagKey to value. */
  flags?: Record<string, unknown>;
  /**
   * The evaluation context the mock is bound to. Default
   * `{ kind: 'user', key: 'test-user' }`. Combines with `flags`; ignored
   * when `client` or `options` is passed, because those carry their own.
   */
  context?: EvalContext;
}

/**
 * Resolve provider props to the client the tree will use.
 *
 * Precedence: `client`, then `options`, then `flags` and `context` together,
 * then an empty mock.
 */
export function resolveTestClient(props: TestClientProps): MockClient {
  if (props.client) return props.client;
  if (props.options) return createMockClient(props.options);
  if (props.flags || props.context) {
    return createMockClient({
      ...(props.flags !== undefined ? { flags: props.flags } : {}),
      ...(props.context !== undefined ? { context: props.context } : {}),
    });
  }
  return createMockClient();
}
