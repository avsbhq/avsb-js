import { afterEach, beforeEach } from 'vitest'
import { createMockClient, type MockClient, type MockClientOptions } from './createMockClient'

export type { MockClient, MockClientOptions }

let activeClient: MockClient | null = null

/**
 * Vitest test lifecycle helper for @avsbhq/test.
 *
 * Sets up a fresh MockClient before each test and closes it after.
 *
 * @example
 *   import { setupAvsbTest } from '@avsbhq/test/vitest'
 *
 *   describe('my feature', () => {
 *     const { getClient } = setupAvsbTest({ flags: { 'checkout-v2': true } })
 *
 *     it('uses the mock client', () => {
 *       const client = getClient()
 *       expect(client.getBoolFlag('checkout-v2', false).value).toBe(true)
 *     })
 *   })
 */
export function setupAvsbTest(opts?: MockClientOptions): { getClient(): MockClient } {
  beforeEach(() => {
    activeClient = createMockClient(opts)
  })

  afterEach(async () => {
    await activeClient?.close()
    activeClient = null
  })

  return {
    getClient(): MockClient {
      if (!activeClient) {
        throw new Error(
          'setupAvsbTest: no active client. Ensure getClient() is called inside a test, not at module scope.'
        )
      }
      return activeClient
    },
  }
}
