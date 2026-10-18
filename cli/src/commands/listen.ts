/**
 * `avsb listen` — watch this project's webhook deliveries, and optionally replay
 * each one to a local URL.
 *
 * Every delivery the platform attempts is published to a per-project channel on
 * the same stream worker the SDKs use for datafile updates. This command asks the
 * platform for a short-lived ticket, opens the channel, prints what arrives, and
 * (with `--forward`) POSTs an exact copy to a local address: same body bytes,
 * same signature headers, so `verifyWebhookSignature` passes locally.
 *
 * Nothing is invented here. What you see is what your endpoint was sent.
 */

import { Command } from 'commander'
import { ensureLoggedIn } from '../lib/config.js'
import { WebhookApiClient } from '../lib/webhookApi.js'
import { CliError } from '../lib/cliError.js'
import { EXIT } from '../lib/exitCodes.js'
import * as logger from '../lib/logger.js'
import { failCommand } from '../lib/output.js'
import { resolveProjectShortId } from './metrics.helpers.js'
import {
  MAX_RELAY_RECONNECT_ATTEMPTS,
  buildForwardHeaders,
  buildRelayStreamUrl,
  formatDeliveryLine,
  formatForwardLine,
  nextRelayBackoffMs,
  parseRelayFrame,
  readSseData,
  splitSseLines,
  validateForwardUrl,
  type WebhookRelayTicket,
} from '../lib/webhookRelay.js'

export interface RelayTotals {
  received: number
  forwarded: number
  forwardFailures: number
}

export interface RelayConnectionResult extends RelayTotals {
  /** How the connection finished. */
  outcome: 'ended' | 'stopped' | 'unauthorized' | 'failed'
  /** True once the stream opened, so a caller can tell "never connected" apart. */
  connected: boolean
  error?: string
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

/** Wait, but wake up immediately when the user presses Ctrl+C. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/**
 * Open the relay channel once and pump frames until it closes, the user stops, or
 * it fails. One connection per call: the reconnect loop lives in the command, so
 * this stays straightforward to test.
 */
export async function streamRelayOnce(options: {
  ticket: WebhookRelayTicket
  forwardUrl: string | null
  signal?: AbortSignal
  /** Called once the stream is actually open, so nothing claims to be listening early. */
  onConnected?: () => void
}): Promise<RelayConnectionResult> {
  const { ticket, forwardUrl, signal, onConnected } = options
  const totals: RelayTotals = { received: 0, forwarded: 0, forwardFailures: 0 }

  let response: Response
  try {
    response = await fetch(buildRelayStreamUrl(ticket), {
      headers: { Accept: 'text/event-stream' },
      signal,
    })
  } catch (err) {
    if (signal?.aborted) return { ...totals, outcome: 'stopped', connected: false }
    return {
      ...totals,
      outcome: 'failed',
      connected: false,
      error: errorMessage(err, 'could not reach the stream'),
    }
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ...totals,
      outcome: 'unauthorized',
      connected: false,
      error: `the stream rejected the ticket (HTTP ${response.status})`,
    }
  }
  if (response.status === 429) {
    // The channel allows 100 connections a minute per project. Say so, because
    // "HTTP 429" on its own reads like a platform outage.
    return {
      ...totals,
      outcome: 'failed',
      connected: false,
      error: 'too many connection attempts for this project (HTTP 429). Wait a minute.',
    }
  }
  if (!response.ok || !response.body) {
    return {
      ...totals,
      outcome: 'failed',
      connected: false,
      error: `HTTP ${response.status}`,
    }
  }

  onConnected?.()

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const { lines, rest } = splitSseLines(buffer)
      buffer = rest

      for (const line of lines) {
        const data = readSseData(line)
        if (!data) continue
        const frame = parseRelayFrame(data)
        if (!frame) continue

        totals.received += 1
        logger.line(formatDeliveryLine(frame))

        if (!forwardUrl) continue
        try {
          const forwarded = await fetch(forwardUrl, {
            method: 'POST',
            headers: buildForwardHeaders(frame),
            body: frame.body,
          })
          logger.line(formatForwardLine(forwardUrl, { status: forwarded.status }))
          if (forwarded.status >= 200 && forwarded.status < 300) {
            totals.forwarded += 1
          } else {
            totals.forwardFailures += 1
          }
        } catch (err) {
          totals.forwardFailures += 1
          // A local server that is down or restarting must not end the session.
          logger.warn(
            formatForwardLine(forwardUrl, {
              error: errorMessage(err, 'unknown error'),
            }),
          )
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) return { ...totals, outcome: 'stopped', connected: true }
    return {
      ...totals,
      outcome: 'failed',
      connected: true,
      error: errorMessage(err, 'the stream ended unexpectedly'),
    }
  }

  if (signal?.aborted) return { ...totals, outcome: 'stopped', connected: true }
  return { ...totals, outcome: 'ended', connected: true }
}

function printSecretHint(): void {
  logger.line()
  logger.heading('Verifying signatures locally')
  logger.dim(
    '  A vs B shows a webhook signing secret only when the webhook is created and when its',
  )
  logger.dim('  secret is rotated, so copy it then. If you no longer have it, rotate it:')
  logger.dim('    Dashboard: Organization Settings > Integrations > Webhooks')
  logger.dim('    API: POST /api/v1/projects/{projectId}/webhooks/{webhookId}/secret')
  logger.dim(
    '  Put it in AVSB_WEBHOOK_SECRET and verify with verifyWebhookSignature from @avsbhq/node.',
  )
}

function printSummary(totals: RelayTotals): void {
  logger.line()
  logger.label('Deliveries received', String(totals.received))
  if (totals.forwarded > 0 || totals.forwardFailures > 0) {
    logger.label('Forwarded', String(totals.forwarded))
    logger.label('Forward failures', String(totals.forwardFailures))
  }
}

export const listenCommand = new Command('listen')
  .description("Watch this project's webhook deliveries and forward them to a local URL")
  .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
  .option('--forward <url>', 'POST a copy of each delivery to this URL')
  .option('--print-secret-hint', 'Explain where to get the signing secret for local verification')
  .action(
    async (opts: { project?: string; forward?: string; printSecretHint?: boolean }) => {
      const session = ensureLoggedIn()
      const projectShortId = resolveProjectShortId(opts)

      let forwardUrl: string | null = null
      if (opts.forward) {
        const validated = validateForwardUrl(opts.forward)
        if (!validated.ok) {
          // A value typed wrong is a usage error, exit 2 (QA N4-20).
          failCommand(new CliError('cli_usage', validated.reason))
        }
        forwardUrl = validated.url
      }

      const api = new WebhookApiClient(session)
      const controller = new AbortController()
      let stopping = false
      const stop = (): void => {
        stopping = true
        controller.abort()
      }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)

      logger.heading(`Webhook relay for PRJ-${projectShortId}`)
      logger.label('Forwarding to', forwardUrl ?? 'nothing (printing only)')
      if (opts.printSecretHint) printSecretHint()
      logger.line()

      const totals: RelayTotals = { received: 0, forwarded: 0, forwardFailures: 0 }
      let connections = 0
      let consecutiveFailures = 0

      const giveUp = (message: string): never => {
        logger.error(message)
        printSummary(totals)
        process.exit(EXIT.failure)
      }

      while (!stopping) {
        let ticket: WebhookRelayTicket
        try {
          ticket = (await api.getWebhookRelayTicket(projectShortId)).data
        } catch (err) {
          const message = errorMessage(err, 'could not get a relay ticket')
          if (connections === 0) {
            logger.error(`Could not start listening: ${message}`)
            logger.dim(
              '  Check that the token can reach this project, and that webhooks are enabled for your plan.',
            )
            process.exit(EXIT.failure)
          }
          consecutiveFailures += 1
          if (consecutiveFailures >= MAX_RELAY_RECONNECT_ATTEMPTS) {
            giveUp(
              `Gave up after ${consecutiveFailures} failed reconnects. Last error: ${message}`,
            )
          }
          logger.warn(`Reconnecting after: ${message}`)
          await sleep(nextRelayBackoffMs(consecutiveFailures), controller.signal)
          continue
        }

        const result = await streamRelayOnce({
          ticket,
          forwardUrl,
          signal: controller.signal,
          onConnected: () => {
            if (connections === 0) logger.success('Listening. Press Ctrl+C to stop.')
          },
        })
        totals.received += result.received
        totals.forwarded += result.forwarded
        totals.forwardFailures += result.forwardFailures
        if (result.connected) connections += 1

        if (result.outcome === 'stopped') break

        if (result.outcome === 'unauthorized') {
          giveUp(
            `The relay ticket was rejected: ${result.error ?? 'unauthorized'}. Run \`avsb whoami\` to check which account this token reaches.`,
          )
        }

        if (result.outcome === 'ended') {
          // A clean close is normal: the channel evicts idle or slow connections
          // and expects the client to come straight back.
          consecutiveFailures = 0
          if (stopping) break
          logger.dim('  Stream closed by the platform. Reconnecting...')
        } else {
          // A connection that never opened on the very first attempt is a setup
          // problem, not a blip, so it fails fast instead of retrying for a minute.
          if (connections === 0) {
            logger.error(`Could not connect to the relay: ${result.error ?? 'unknown error'}`)
            process.exit(EXIT.failure)
          }
          consecutiveFailures += 1
          if (consecutiveFailures >= MAX_RELAY_RECONNECT_ATTEMPTS) {
            giveUp(
              `Gave up after ${consecutiveFailures} failed reconnects. Last error: ${result.error ?? 'unknown error'}`,
            )
          }
          logger.warn(`Connection lost: ${result.error ?? 'unknown error'}`)
        }

        if (stopping) break
        await sleep(nextRelayBackoffMs(consecutiveFailures), controller.signal)
      }

      logger.info('Stopped listening.')
      printSummary(totals)
      process.exit(EXIT.success)
    },
  )
