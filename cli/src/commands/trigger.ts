/**
 * `avsb trigger <event>` — send a sample payload for one event to this project's
 * webhooks, so a local handler can be built and tested before the real event
 * ever fires.
 *
 * The sample runs through the platform's normal delivery path: it is persisted,
 * signed, POSTed to the configured URL, and relayed to `avsb listen`. Bodies are
 * marked `test: true` and their entity ids start with `sample_`, so nothing looks
 * like a real record.
 *
 * The event catalog comes from the platform on every run rather than being copied
 * into the CLI, so this command cannot advertise an event the platform does not
 * have.
 */

import { Command } from 'commander'
import { ensureLoggedIn } from '../lib/config.js'
import { WebhookApiClient } from '../lib/webhookApi.js'
import { CliError } from '../lib/cliError.js'
import { EXIT } from '../lib/exitCodes.js'
import * as logger from '../lib/logger.js'
import { startSpinner } from '../lib/outputMode.js'
import {
  beginCommand,
  emitJsonResult,
  failCommand,
  withOutputOptions,
} from '../lib/output.js'
import { resolveProjectShortId } from './metrics.helpers.js'
import {
  formatTriggerDeliveryLine,
  type WebhookEventChoice,
  type WebhookTriggerDelivery,
} from '../lib/webhookRelay.js'

/** Actionable message when the named event is not in the platform catalog. */
export function describeUnknownEvent(
  eventName: string,
  events: WebhookEventChoice[],
): string {
  if (events.length === 0) {
    return `Cannot check "${eventName}": the platform returned no event names.`
  }
  return `Unknown event "${eventName}". Run \`avsb trigger --list\` to see all ${events.length} event names.`
}

function printEventTable(events: WebhookEventChoice[]): void {
  const width = Math.max(5, ...events.map((event) => event.name.length))
  logger.line()
  logger.heading('Events you can trigger')
  logger.line()
  for (const event of events) {
    logger.line(`  ${event.name.padEnd(width)}  ${event.label}`)
  }
  logger.line()
  logger.dim('  Send one with `avsb trigger <event>`')
}

export const triggerCommand = withOutputOptions(
  new Command('trigger')
    .description("Send a sample webhook event to this project's webhooks")
    .argument('[event]', 'Event name, for example experiment.launched')
    .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
    .option('--webhook <id>', 'Send to one webhook instead of every enabled one')
    .option('--list', 'List the event names you can trigger, and send nothing'),
).action(
    async (
      eventArg: string | undefined,
      opts: {
        project?: string
        webhook?: string
        list?: boolean
        json?: boolean
        quiet?: boolean
      },
    ) => {
      beginCommand(opts.list ? 'trigger --list' : 'trigger', opts)
      const session = ensureLoggedIn()
      const projectShortId = resolveProjectShortId(opts)
      const api = new WebhookApiClient(session)

      let catalog: { events: WebhookEventChoice[] }
      try {
        catalog = (await api.listWebhookEvents(projectShortId)).data
      } catch (err) {
        failCommand(err)
      }
      const events = catalog.events

      if (opts.list) {
        // The platform's own catalog body, unchanged.
        if (emitJsonResult(catalog)) return
        printEventTable(events)
        return
      }

      if (!eventArg) {
        printEventTable(events)
        failCommand(new CliError('cli_usage', 'Name an event: `avsb trigger <event>`.'))
      }

      if (!events.some((event) => event.name === eventArg)) {
        printEventTable(events)
        failCommand(new CliError('cli_usage', describeUnknownEvent(eventArg, events)))
      }

      const spinner = startSpinner(`Sending ${eventArg}...`)
      let sent: { event: string; deliveries: WebhookTriggerDelivery[] }
      let deliveries: WebhookTriggerDelivery[]
      try {
        const response = await api.triggerWebhookEvent(projectShortId, {
          event: eventArg,
          webhookId: opts.webhook,
        })
        sent = response.data
        deliveries = response.data.deliveries
        spinner.succeed(
          `Sent ${eventArg} to ${deliveries.length} webhook${deliveries.length === 1 ? '' : 's'}`,
        )
      } catch (err) {
        spinner.fail(`Could not send ${eventArg}`)
        failCommand(err)
      }

      if (emitJsonResult(sent)) {
        // A refused delivery is still a failed run, even in JSON mode.
        if (deliveries.some((delivery) => delivery.error !== null)) {
          process.exit(EXIT.failure)
        }
        return
      }

      logger.line()
      for (const delivery of deliveries) {
        logger.line(formatTriggerDeliveryLine(delivery))
      }
      logger.line()
      logger.dim(
        '  Run `avsb listen --forward <url>` in another terminal to receive these locally',
      )

      // The platform accepted the trigger, so this is not a CLI failure, but an
      // endpoint that refused the delivery must not read as success either.
      if (deliveries.some((delivery) => delivery.error !== null)) {
        logger.warn('At least one webhook did not accept the delivery. See the lines above.')
        process.exit(EXIT.failure)
      }
    },
  )
