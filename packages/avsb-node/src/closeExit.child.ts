// Child process for closeExit.test.ts (N1-6). Not part of the package:
// tsup builds src/index.ts only, and no test runner collects this file.
//
// Loads the datafile from the CDN origin passed as argv[2], awaits
// onReady(), close()s, and reports how long the event loop stayed busy
// after close() returned. Before the fix the init timer kept it busy for
// the whole initTimeout (30 seconds here, to make a regression obvious).

import { writeSync } from 'node:fs'
import { AvsbServer } from './AvsbServer'

async function main(): Promise<void> {
  const server = new AvsbServer({
    sdkKey: 'sdk_production_closeexitchild01',
    cdnHost: process.argv[2],
    streaming: false,
    initTimeout: 30_000,
    logLevel: 'silent',
  })
  const result = await server.onReady()
  await server.close()
  const closedAt = Date.now()

  // `beforeExit` fires once nothing is left on the event loop, which is
  // exactly the moment this test measures. writeSync, because an async
  // write scheduled here would itself keep the loop busy.
  process.once('beforeExit', () => {
    writeSync(
      1,
      `${JSON.stringify({
        success: result.success,
        source: result.source,
        lingerMs: Date.now() - closedAt,
      })}\n`
    )
  })
}

void main()
