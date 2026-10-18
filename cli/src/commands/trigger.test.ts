import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AvsbSession } from '../types/config.js'
import type { WebhookTriggerDelivery } from '../lib/webhookRelay.js'

const mocks = vi.hoisted(() => {
  const spinner = {
    succeed: vi.fn(),
    fail: vi.fn(),
    stop: vi.fn(),
    warn: vi.fn(),
    text: '',
    start: vi.fn(),
  }
  spinner.start.mockReturnValue(spinner)

  return {
    spinner,
    ora: vi.fn(() => spinner),
    ensureLoggedIn: vi.fn(),
    listWebhookEvents: vi.fn(),
    triggerWebhookEvent: vi.fn(),
    logger: {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      dim: vi.fn(),
      heading: vi.fn(),
      label: vi.fn(),
      field: vi.fn(),
      fileTree: vi.fn(),
      errorDetail: vi.fn(),
      line: vi.fn(),
    },
  }
})

vi.mock('ora', () => ({ default: mocks.ora }))
vi.mock('../lib/logger.js', () => mocks.logger)
vi.mock('../lib/config.js', () => ({
  ensureLoggedIn: mocks.ensureLoggedIn,
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  getConfigPath: () => '/home/tester/.avsb/config.json',
}))
vi.mock('../lib/webhookApi.js', () => ({
  WebhookApiClient: class {
    listWebhookEvents = mocks.listWebhookEvents
    triggerWebhookEvent = mocks.triggerWebhookEvent
  },
}))

class ProcessExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

function session(): AvsbSession {
  return {
    token: 'pat_acme',
    orgId: 'org-1',
    orgName: 'Acme Corp',
    apiBaseUrl: 'https://app.avsb.cloud',
    tokenSource: 'config',
  }
}

const EVENTS = [
  { name: 'experiment.launched', label: 'Experiment launched' },
  { name: 'flag.published', label: 'Feature flag published' },
  { name: 'commerce.job_failed', label: 'Commerce background job failed' },
]

function delivery(overrides: Partial<WebhookTriggerDelivery> = {}): WebhookTriggerDelivery {
  return {
    webhookId: 'hook-1',
    webhookName: 'Local dev',
    url: 'https://example.com/hook',
    deliveryId: 'del-1',
    status: 'DELIVERED',
    responseStatus: 200,
    error: null,
    ...overrides,
  }
}

/** Fresh command per run: commander keeps option values on the instance. */
async function runTrigger(argv: string[]): Promise<void> {
  vi.resetModules()
  const { triggerCommand } = await import('./trigger.js')
  await triggerCommand.parseAsync(argv, { from: 'user' })
}

/**
 * Everything the command wrote to stdout. Result lines go through
 * `logger.line`, which is mocked here, so read them from there rather than from
 * `console.log`.
 */
function printed(): string {
  return mocks.logger.line.mock.calls.map((call) => String(call[0] ?? '')).join('\n')
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.spinner.start.mockReturnValue(mocks.spinner)
  mocks.ensureLoggedIn.mockReturnValue(session())
  mocks.listWebhookEvents.mockResolvedValue({ data: { events: EVENTS } })
  mocks.triggerWebhookEvent.mockResolvedValue({
    data: { event: 'experiment.launched', deliveries: [delivery()] },
  })
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ProcessExitError(typeof code === 'number' ? code : 0)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('describeUnknownEvent', () => {
  it('points at the list command instead of guessing what was meant', async () => {
    const { describeUnknownEvent } = await import('./trigger.js')

    const message = describeUnknownEvent('experiment.exploded', EVENTS)

    expect(message).toContain('Unknown event "experiment.exploded"')
    expect(message).toContain('avsb trigger --list')
    expect(message).toContain('3 event names')
  })

  it('says so plainly when the platform returned no events', async () => {
    const { describeUnknownEvent } = await import('./trigger.js')

    expect(describeUnknownEvent('anything', [])).toContain('no event names')
  })
})

describe('avsb trigger', () => {
  it('sends the named event and prints one line per delivery', async () => {
    mocks.triggerWebhookEvent.mockResolvedValue({
      data: {
        event: 'experiment.launched',
        deliveries: [delivery(), delivery({ webhookId: 'hook-2', webhookName: 'Staging' })],
      },
    })

    await runTrigger(['experiment.launched', '--project', '42'])

    expect(mocks.triggerWebhookEvent).toHaveBeenCalledWith(42, {
      event: 'experiment.launched',
      webhookId: undefined,
    })
    expect(mocks.spinner.succeed).toHaveBeenCalledWith(
      'Sent experiment.launched to 2 webhooks',
    )
    expect(printed()).toContain('Local dev')
    expect(printed()).toContain('Staging')
  })

  it('narrows to one webhook with --webhook', async () => {
    await runTrigger(['flag.published', '--project', '42', '--webhook', 'hook-9'])

    expect(mocks.triggerWebhookEvent).toHaveBeenCalledWith(42, {
      event: 'flag.published',
      webhookId: 'hook-9',
    })
  })

  it('lists the platform event names with --list and sends nothing', async () => {
    await runTrigger(['--list', '--project', '42'])

    expect(mocks.triggerWebhookEvent).not.toHaveBeenCalled()
    expect(printed()).toContain('experiment.launched')
    expect(printed()).toContain('Feature flag published')
  })

  it('refuses an unknown event, lists the valid ones, and exits 1', async () => {
    await expect(runTrigger(['experiment.exploded', '--project', '42'])).rejects.toThrow(
      ProcessExitError,
    )

    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown event "experiment.exploded"'),
    )
    expect(printed()).toContain('commerce.job_failed')
    expect(mocks.triggerWebhookEvent).not.toHaveBeenCalled()
  })

  it('asks for an event name when none is given', async () => {
    await expect(runTrigger(['--project', '42'])).rejects.toThrow(ProcessExitError)

    expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('Name an event'))
    expect(mocks.triggerWebhookEvent).not.toHaveBeenCalled()
  })

  it('exits 1 when the event list cannot be loaded', async () => {
    mocks.listWebhookEvents.mockRejectedValue(new Error('Forbidden'))

    await expect(runTrigger(['experiment.launched', '--project', '42'])).rejects.toThrow(
      ProcessExitError,
    )

    expect(mocks.logger.error).toHaveBeenCalledWith('Forbidden')
    expect(mocks.triggerWebhookEvent).not.toHaveBeenCalled()
  })

  it('surfaces the platform message when the trigger is refused', async () => {
    mocks.triggerWebhookEvent.mockRejectedValue(
      new Error('This project has no enabled webhook to deliver to.'),
    )

    await expect(runTrigger(['experiment.launched', '--project', '42'])).rejects.toThrow(
      ProcessExitError,
    )

    expect(mocks.spinner.fail).toHaveBeenCalledWith('Could not send experiment.launched')
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'This project has no enabled webhook to deliver to.',
    )
  })

  it('exits 1 when a webhook refused the delivery, after printing the outcome', async () => {
    mocks.triggerWebhookEvent.mockResolvedValue({
      data: {
        event: 'experiment.launched',
        deliveries: [
          delivery({ status: 'FAILED', responseStatus: 500, error: 'HTTP 500' }),
        ],
      },
    })

    await expect(runTrigger(['experiment.launched', '--project', '42'])).rejects.toThrow(
      ProcessExitError,
    )

    expect(printed()).toContain('HTTP 500')
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('did not accept the delivery'),
    )
  })

  it('points at `avsb listen` as the other half of the loop', async () => {
    await runTrigger(['experiment.launched', '--project', '42'])

    expect(mocks.logger.dim).toHaveBeenCalledWith(expect.stringContaining('avsb listen'))
  })

  it('refuses an unparseable --project value', async () => {
    await expect(runTrigger(['experiment.launched', '--project', 'nope'])).rejects.toThrow(
      ProcessExitError,
    )

    expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid --project'))
    expect(mocks.listWebhookEvents).not.toHaveBeenCalled()
  })
})
