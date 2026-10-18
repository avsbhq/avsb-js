import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WATCH_INTERVAL_MS,
  MAX_WATCH_INTERVAL_MS,
  MIN_WATCH_INTERVAL_MS,
  nextWatchBackoffMs,
  parseWatchInterval,
  runWatchLoop,
  type WatchEvent,
} from './codegenWatch.js'

interface FakeDatafile {
  version: number
}

type FetchAnswer =
  | { status: 'not-modified'; etag: string | null }
  | { status: 'ok'; datafile: FakeDatafile; etag: string | null }
  | { throws: string }

/**
 * Run the loop over a scripted list of answers, stopping as soon as they run
 * out. No timers, no network: `sleep` resolves immediately and the abort is
 * driven by the script.
 */
async function runScript(
  answers: FetchAnswer[],
  options: {
    written?: string[][]
    /** A non-null entry makes that write throw, e.g. a read-only checkout. */
    writeErrors?: Array<string | null>
    maxFailures?: number
  } = {},
) {
  const controller = new AbortController()
  const events: WatchEvent[] = []
  const etagsSeen: Array<string | null> = []
  const slept: number[] = []
  let call = 0
  let writes = 0

  const summary = await runWatchLoop<FakeDatafile>({
    intervalMs: 1000,
    signal: controller.signal,
    maxFailures: options.maxFailures,
    sleep: async (ms) => {
      slept.push(ms)
    },
    onEvent: (event) => events.push(event),
    fetchDatafile: async (etag) => {
      etagsSeen.push(etag)
      const answer: FetchAnswer | undefined = answers[call]
      call += 1
      if (call >= answers.length) controller.abort()
      if (!answer) throw new Error('script exhausted')
      if ('throws' in answer) throw new Error(answer.throws)
      return answer
    },
    writeOutputs: async () => {
      const failure = options.writeErrors?.[writes] ?? null
      const written = options.written?.[writes] ?? ['/repo/flags.ts']
      writes += 1
      if (failure !== null) throw new Error(failure)
      return written
    },
  })

  return { summary, events, etagsSeen, slept }
}

describe('runWatchLoop', () => {
  it('reports a stop and returns a clean summary when the user aborts', async () => {
    const { summary, events } = await runScript([{ status: 'not-modified', etag: null }])
    expect(summary.gaveUp).toBe(false)
    expect(summary.failures).toBe(0)
    expect(events.at(-1)).toEqual({ kind: 'stopped' })
  })

  it('writes nothing when the platform says the datafile has not changed', async () => {
    const { summary, events } = await runScript([{ status: 'not-modified', etag: 'W/"1"' }])
    expect(summary.regenerations).toBe(0)
    expect(events[0]).toEqual({ kind: 'polled', changed: false, notModified: true })
  })

  it('reports the files it rewrote when the datafile changes', async () => {
    const { summary, events } = await runScript(
      [{ status: 'ok', datafile: { version: 2 }, etag: null }],
      { written: [['/repo/flags.ts', '/repo/flags.json']] },
    )
    expect(summary.regenerations).toBe(1)
    expect(events[0]).toEqual({
      kind: 'polled',
      changed: true,
      notModified: false,
      written: ['/repo/flags.ts', '/repo/flags.json'],
    })
  })

  it('counts a new datafile that generates identical output as no change', async () => {
    const { summary, events } = await runScript(
      [{ status: 'ok', datafile: { version: 2 }, etag: null }],
      { written: [[]] },
    )
    expect(summary.regenerations).toBe(0)
    expect(events[0]).toEqual({ kind: 'polled', changed: false, notModified: false })
  })

  it('sends the previous ETag on the next poll', async () => {
    const { etagsSeen } = await runScript([
      { status: 'ok', datafile: { version: 1 }, etag: 'W/"a"' },
      { status: 'not-modified', etag: 'W/"a"' },
    ])
    expect(etagsSeen).toEqual([null, 'W/"a"'])
  })

  it('starts from the ETag the first generation already had', async () => {
    const controller = new AbortController()
    const etagsSeen: Array<string | null> = []
    await runWatchLoop<FakeDatafile>({
      intervalMs: 1000,
      initialEtag: 'W/"first"',
      signal: controller.signal,
      sleep: async () => undefined,
      onEvent: () => undefined,
      fetchDatafile: async (etag) => {
        etagsSeen.push(etag)
        controller.abort()
        return { status: 'not-modified', etag }
      },
      writeOutputs: async () => [],
    })
    expect(etagsSeen).toEqual(['W/"first"'])
  })

  it('does not keep the new ETag when the write failed, so the next poll refetches', async () => {
    // Committing the ETag before the write means a read-only checkout leaves the
    // files stale while every later poll answers 304: broken, and silent.
    const { etagsSeen, summary } = await runScript(
      [
        { status: 'ok', datafile: { version: 1 }, etag: 'W/"new"' },
        { status: 'ok', datafile: { version: 1 }, etag: 'W/"new"' },
      ],
      { writeErrors: ['read-only file system', null] },
    )
    expect(etagsSeen).toEqual([null, null])
    expect(summary.failures).toBe(1)
    expect(summary.regenerations).toBe(1)
  })

  it('reports a failure, keeps going, and backs off before the retry', async () => {
    const { summary, events, slept } = await runScript([
      { throws: 'network down' },
      { status: 'not-modified', etag: null },
    ])
    expect(summary.failures).toBe(1)
    expect(summary.gaveUp).toBe(false)
    expect(events[0]).toEqual({
      kind: 'failed',
      message: 'network down',
      attempt: 1,
      retryInMs: 1000,
    })
    // First wait is the plain interval; the second is the backoff.
    expect(slept).toEqual([1000, 1000])
  })

  it('gives up after too many consecutive failures instead of spinning', async () => {
    const { summary, events } = await runScript(
      [{ throws: 'nope' }, { throws: 'nope' }, { throws: 'nope' }],
      { maxFailures: 2 },
    )
    expect(summary.gaveUp).toBe(true)
    expect(summary.lastError).toBe('nope')
    expect(events.some((e) => e.kind === 'stopped')).toBe(false)
  })

  it('resets the failure count after a poll succeeds', async () => {
    const { summary } = await runScript(
      [{ throws: 'blip' }, { status: 'not-modified', etag: null }, { throws: 'blip' }],
      { maxFailures: 2 },
    )
    expect(summary.gaveUp).toBe(false)
    expect(summary.failures).toBe(2)
  })
})

describe('nextWatchBackoffMs', () => {
  it('waits the plain interval on the first failure', () => {
    expect(nextWatchBackoffMs(10_000, 1)).toBe(10_000)
  })

  it('doubles with each consecutive failure', () => {
    expect(nextWatchBackoffMs(10_000, 2)).toBe(20_000)
    expect(nextWatchBackoffMs(10_000, 3)).toBe(40_000)
  })

  it('never waits longer than a minute', () => {
    expect(nextWatchBackoffMs(10_000, 9)).toBe(60_000)
  })
})

describe('parseWatchInterval', () => {
  it('defaults when no interval is given', () => {
    expect(parseWatchInterval(undefined)).toEqual({ ms: DEFAULT_WATCH_INTERVAL_MS })
  })

  it('reads seconds and converts to milliseconds', () => {
    expect(parseWatchInterval('30')).toEqual({ ms: 30_000 })
  })

  it('refuses a value that is not a positive number', () => {
    expect(parseWatchInterval('soon')).toHaveProperty('error')
    expect(parseWatchInterval('-5')).toHaveProperty('error')
    expect(parseWatchInterval('0')).toHaveProperty('error')
  })

  it('refuses a poll faster than the datafile cache, and says why', () => {
    const result = parseWatchInterval(String(MIN_WATCH_INTERVAL_MS / 1000 - 1))
    expect(result).toHaveProperty('error')
    if ('error' in result) expect(result.error).toContain('cached for 60 seconds')
  })

  it('refuses an interval longer than the cap', () => {
    expect(parseWatchInterval(String(MAX_WATCH_INTERVAL_MS / 1000 + 1))).toHaveProperty('error')
  })
})
