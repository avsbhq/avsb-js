/**
 * The loudness contract, asserted as a property of every message rather
 * than by pinning prose: each string has to name WHAT failed, the EXACT
 * value involved, and WHERE the fix is (spec §1.2). A message that drifts
 * into "something went wrong" fails here.
 */
import { describe, expect, it } from 'vitest'
import {
  NOT_READY_REASON,
  allFlagsNotReadyMessage,
  datafileHttpFailureMessage,
  datafileUnavailableMessage,
  notReadyReadMessage,
  pendingQueueFullMessage,
  trackAfterCloseMessage,
  typedGetterMismatchMessage,
} from './messages'

const ALL: Array<{ name: string; message: string }> = [
  { name: 'notReadyReadMessage', message: notReadyReadMessage('checkout_v2') },
  { name: 'allFlagsNotReadyMessage', message: allFlagsNotReadyMessage() },
  { name: 'trackAfterCloseMessage', message: trackAfterCloseMessage('purchase') },
  { name: 'pendingQueueFullMessage', message: pendingQueueFullMessage(100, 7) },
  {
    name: 'typedGetterMismatchMessage',
    message: typedGetterMismatchMessage('checkout_v2', 'boolean', 'declared as "string"'),
  },
  {
    name: 'datafileHttpFailureMessage',
    message: datafileHttpFailureMessage(404, 'https://cdn.avsb.cloud/sdk_x/datafile.json'),
  },
  {
    name: 'datafileUnavailableMessage',
    message: datafileUnavailableMessage('https://cdn.avsb.cloud/sdk_x/datafile.json'),
  },
]

describe('customer-facing messages', () => {
  it('all name the product, so a console line is attributable', () => {
    for (const { name, message } of ALL) {
      expect(message, name).toContain('AvsB')
    }
  })

  it('all say what to do next, not just what broke', () => {
    // Every message must contain at least one actionable pointer.
    const actionable = /onReady|bootstrap|Environments|maxPendingEvents|getter|close\(\)/
    for (const { name, message } of ALL) {
      expect(message, name).toMatch(actionable)
    }
  })

  it('use no em-dash, per the copy rules', () => {
    for (const { name, message } of ALL) {
      expect(message.includes('—'), name).toBe(false)
    }
    expect(NOT_READY_REASON.includes('—')).toBe(false)
  })

  it('interpolates the exact values involved', () => {
    expect(notReadyReadMessage('checkout_v2')).toContain('"checkout_v2"')
    expect(pendingQueueFullMessage(100, 7)).toContain('100')
    expect(pendingQueueFullMessage(100, 7)).toContain('7')
    expect(trackAfterCloseMessage('purchase')).toContain('"purchase"')
    expect(
      datafileHttpFailureMessage(500, 'https://cdn.avsb.cloud/sdk_x/datafile.json'),
    ).toContain('500')
    expect(
      datafileHttpFailureMessage(500, 'https://cdn.avsb.cloud/sdk_x/datafile.json'),
    ).toContain('https://cdn.avsb.cloud/sdk_x/datafile.json')
  })

  it('explains a 404 as a wrong key, and other statuses as a CDN problem', () => {
    const notFound = datafileHttpFailureMessage(404, 'https://cdn.avsb.cloud/x/datafile.json')
    expect(notFound).toContain('does not exist')
    expect(notFound).toContain('Environments')

    const serverError = datafileHttpFailureMessage(503, 'https://cdn.avsb.cloud/x/datafile.json')
    expect(serverError).toContain('could not serve')
    expect(serverError).not.toContain('does not exist')
  })
})
