import { describe, expect, it } from 'vitest'
import {
  CLOCK_ALLOWANCE_MS,
  heartbeatTimeoutGuidance,
  isFreshHeartbeat,
  isNewerThan,
  waitForHeartbeat,
  type HeartbeatSample,
} from './heartbeatWait.js'

const START = Date.parse('2026-08-05T12:00:00.000Z')

function sample(overrides: Partial<HeartbeatSample> = {}): HeartbeatSample {
  return { lastSdkSeenAt: null, lastSdkType: null, lastSdkVersion: null, ...overrides }
}

/** A clock the test advances by hand, so no branch waits on a real timer. */
function fakeClock(startMs: number) {
  let now = startMs
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms
    },
  }
}

describe('isFreshHeartbeat', () => {
  it('accepts a check-in from after the run started', () => {
    expect(isFreshHeartbeat(new Date(START + 1000).toISOString(), START)).toBe(true)
  })

  it('rejects a check-in from before it, which proves nothing about this setup', () => {
    const lastWeek = new Date(START - 7 * 24 * 60 * 60 * 1000).toISOString()

    expect(isFreshHeartbeat(lastWeek, START)).toBe(false)
  })

  it('tolerates the platform clock sitting slightly behind the local one', () => {
    const slightlyBehind = new Date(START - CLOCK_ALLOWANCE_MS + 1000).toISOString()

    expect(isFreshHeartbeat(slightlyBehind, START)).toBe(true)
  })

  it('treats a missing or unparseable stamp as no proof at all', () => {
    expect(isFreshHeartbeat(null, START)).toBe(false)
    expect(isFreshHeartbeat('whenever', START)).toBe(false)
  })
})

describe('waitForHeartbeat', () => {
  it('returns as soon as a fresh check-in appears, with what checked in', async () => {
    const clock = fakeClock(START)
    let calls = 0

    const outcome = await waitForHeartbeat({
      startedAt: START,
      timeoutMs: 30_000,
      intervalMs: 3000,
      now: clock.now,
      sleep: clock.sleep,
      probe: async () => {
        calls += 1
        return calls < 3
          ? sample()
          : sample({
              lastSdkSeenAt: new Date(START + 6000).toISOString(),
              lastSdkType: 'browser',
              lastSdkVersion: '1.0.2',
            })
      },
    })

    expect(outcome.seen).toBe(true)
    if (outcome.seen) {
      expect(outcome.sdkType).toBe('browser')
      expect(outcome.elapsedMs).toBe(6000)
    }
    expect(calls).toBe(3)
  })

  it('gives up at the deadline and reports what was already there', async () => {
    const clock = fakeClock(START)
    const stale = new Date(START - 60 * 60 * 1000).toISOString()

    const outcome = await waitForHeartbeat({
      startedAt: START,
      timeoutMs: 10_000,
      intervalMs: 3000,
      now: clock.now,
      sleep: clock.sleep,
      probe: async () => sample({ lastSdkSeenAt: stale }),
    })

    expect(outcome.seen).toBe(false)
    if (!outcome.seen) {
      expect(outcome.previousSeenAt).toBe(stale)
      expect(outcome.elapsedMs).toBeLessThanOrEqual(10_000)
    }
  })

  it('keeps polling through a failed read instead of calling the setup broken', async () => {
    const clock = fakeClock(START)
    let calls = 0

    const outcome = await waitForHeartbeat({
      startedAt: START,
      timeoutMs: 30_000,
      intervalMs: 3000,
      now: clock.now,
      sleep: clock.sleep,
      probe: async () => {
        calls += 1
        if (calls === 1) throw new Error('network down')
        return sample({ lastSdkSeenAt: new Date(START + 100).toISOString() })
      },
    })

    expect(outcome.seen).toBe(true)
    expect(calls).toBe(2)
  })

  it('stops on the first miss when the window is shorter than one interval', async () => {
    const clock = fakeClock(START)
    let calls = 0

    const outcome = await waitForHeartbeat({
      startedAt: START,
      timeoutMs: 1000,
      intervalMs: 3000,
      now: clock.now,
      sleep: clock.sleep,
      probe: async () => {
        calls += 1
        return sample()
      },
    })

    expect(outcome.seen).toBe(false)
    expect(calls).toBe(1)
  })
})

describe('heartbeatTimeoutGuidance', () => {
  it('names the key and both hosts, and does not claim the setup failed', () => {
    const lines = heartbeatTimeoutGuidance({
      sdkKey: 'sdk_production_abc',
      environmentName: 'Production',
      previousSeenAt: null,
      waitedMs: 120_000,
      cdnHost: 'cdn.avsb.cloud',
      appHost: 'app.avsb.cloud',
    })

    expect(lines[0]).toContain('120s')
    expect(lines[0]).toContain('only the proof is missing')
    expect(lines.join(' ')).toContain('sdk_production_abc')
    expect(lines.join(' ')).toContain('cdn.avsb.cloud')
    expect(lines.join(' ')).toContain('app.avsb.cloud')
  })

  it('says the key has worked before when an older check-in exists', () => {
    const lines = heartbeatTimeoutGuidance({
      sdkKey: 'sdk_production_abc',
      environmentName: 'Production',
      previousSeenAt: '2026-08-01T10:00:00.000Z',
      waitedMs: 30_000,
      cdnHost: 'cdn.avsb.cloud',
      appHost: 'app.avsb.cloud',
    })

    expect(lines.join(' ')).toContain('did check in earlier')
  })

  it('leaves that line out when nothing has ever checked in', () => {
    const lines = heartbeatTimeoutGuidance({
      sdkKey: 'sdk_production_abc',
      environmentName: 'Production',
      previousSeenAt: null,
      waitedMs: 30_000,
      cdnHost: 'cdn.avsb.cloud',
      appHost: 'app.avsb.cloud',
    })

    expect(lines.join(' ')).not.toContain('did check in earlier')
  })
})

// QA N4-12: `init --wait` reported a check-in "347 ms after setup" with no app
// running, because the example had checked in 40 seconds earlier and the
// allowance was a full minute.
describe('a check-in older than the run is not proof', () => {
  it('rejects a check-in from 40 seconds before the wait began', () => {
    expect(isFreshHeartbeat(new Date(START - 40_000).toISOString(), START)).toBe(false)
  })

  it('keeps a small allowance for clock difference, and no more', () => {
    expect(CLOCK_ALLOWANCE_MS).toBeLessThanOrEqual(5_000)
    expect(isFreshHeartbeat(new Date(START - 2_000).toISOString(), START)).toBe(true)
  })

  it('does not report a stale stamp that never moves as a check-in', async () => {
    const clock = fakeClock(START)
    const fortySecondsOld = new Date(START - 40_000).toISOString()

    const outcome = await waitForHeartbeat({
      startedAt: START,
      timeoutMs: 9_000,
      intervalMs: 3000,
      now: clock.now,
      sleep: clock.sleep,
      probe: async () => sample({ lastSdkSeenAt: fortySecondsOld }),
    })

    expect(outcome.seen).toBe(false)
  })

  it('accepts a check-in that arrives while it watches, even when the platform clock is behind', async () => {
    const clock = fakeClock(START)
    const before = new Date(START - 60 * 60 * 1000).toISOString()
    // The platform clock runs ten minutes slow: by the clock rule this stamp
    // is "stale", but it moved while we watched, so a check-in happened.
    const arrived = new Date(START - 10 * 60 * 1000).toISOString()
    let calls = 0

    const outcome = await waitForHeartbeat({
      startedAt: START,
      timeoutMs: 30_000,
      intervalMs: 3000,
      now: clock.now,
      sleep: clock.sleep,
      probe: async () => {
        calls += 1
        return sample({ lastSdkSeenAt: calls < 2 ? before : arrived, lastSdkType: 'node' })
      },
    })

    expect(outcome.seen).toBe(true)
    if (outcome.seen) expect(outcome.at).toBe(arrived)
  })

  it('compares stamps strictly and refuses unparseable ones', () => {
    const a = new Date(START).toISOString()
    const b = new Date(START + 1).toISOString()
    expect(isNewerThan(b, a)).toBe(true)
    expect(isNewerThan(a, a)).toBe(false)
    expect(isNewerThan('soon', a)).toBe(false)
    expect(isNewerThan(b, null)).toBe(false)
  })
})

// QA N4-9: on a brand-new project the proof could not pass until a flag was
// turned on, and neither the timeout nor the "Next" text said so.
describe('turning a flag on is the first cause named', () => {
  const base = {
    sdkKey: 'sdk_production_abc',
    environmentName: 'Production',
    previousSeenAt: null,
    waitedMs: 89_000,
    cdnHost: 'cdn.avsb.cloud',
    appHost: 'app.avsb.cloud',
  }

  it('puts the exact toggle command right under the headline', () => {
    const lines = heartbeatTimeoutGuidance({ ...base, flagKey: 'my_first_flag', environmentKey: 'production' })

    expect(lines[1]).toContain('`avsb flags toggle my_first_flag --env production --on`')
    expect(lines.findIndex((line) => line.includes('Start your app'))).toBeGreaterThan(1)
  })

  it('uses the environment it set up, and a placeholder when the project has no flag yet', () => {
    const lines = heartbeatTimeoutGuidance({ ...base, flagKey: null, environmentKey: 'staging' })

    expect(lines[1]).toContain('`avsb flags toggle <key> --env staging --on`')
  })
})
