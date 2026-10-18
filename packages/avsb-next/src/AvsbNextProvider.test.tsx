/**
 * How the client provider finds what the server left it.
 *
 * The previous version of this file re-implemented the helpers inline and
 * tested the copies, so the shipped code was never exercised. These drive
 * the real exports.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readBootstrapBlob, contextFromBlob } from './AvsbNextProvider'
import { serializeBootstrapBlob, AVSB_BOOTSTRAP_ID } from './AvsbHydrator'
import type { AvsbBootstrapBlob } from './AvsbHydrator'
import type { EvalContext } from '@avsbhq/core'

const FULL_CONTEXT: EvalContext = { kind: 'user', key: 'user-1', plan: 'pro', region: 'eu' }

function makeBlob(partial?: Partial<AvsbBootstrapBlob>): AvsbBootstrapBlob {
  return {
    format: 'avsb-bootstrap-v1',
    producedAt: 1,
    snapshot: {
      capturedAt: 1,
      datafileVersion: '2026-01-01T00:00:00.000Z',
      flags: {},
      contextSummary: [{ kind: 'user', key: 'user-1' }],
    },
    context: FULL_CONTEXT,
    ...partial,
  }
}

function writeScript(text: string): void {
  const element = document.createElement('script')
  element.type = 'application/json'
  element.id = AVSB_BOOTSTRAP_ID
  element.textContent = text
  document.body.appendChild(element)
}

afterEach(() => {
  document.getElementById(AVSB_BOOTSTRAP_ID)?.remove()
  delete (globalThis as { __AVSB_BOOTSTRAP__?: unknown }).__AVSB_BOOTSTRAP__
})

describe('readBootstrapBlob', () => {
  it('reads back exactly what the hydrator wrote, escaping included', () => {
    const hostile = `</${'script'}><${'script'}>window.__pwned=1</${'script'}>`
    const blob = makeBlob({ context: { kind: 'user', key: hostile } })
    // The browser un-escapes on parse, so the value the provider sees is
    // the original one even though no raw < was ever in the HTML.
    writeScript(serializeBootstrapBlob(blob))

    const read = readBootstrapBlob()

    expect((read?.context as { key: string }).key).toBe(hostile)
  })

  it('returns null when there is no blob in the page', () => {
    expect(readBootstrapBlob()).toBeNull()
  })

  it('returns null for a script tag that is not ours', () => {
    writeScript(JSON.stringify({ format: 'something-else', data: 1 }))

    expect(readBootstrapBlob()).toBeNull()
  })

  it('returns null for malformed JSON rather than throwing into a render', () => {
    writeScript('{ not json')

    expect(readBootstrapBlob()).toBeNull()
  })

  it('prefers a window global when a streaming render set one', () => {
    ;(globalThis as { __AVSB_BOOTSTRAP__?: unknown }).__AVSB_BOOTSTRAP__ = makeBlob({
      producedAt: 99,
    })
    writeScript(serializeBootstrapBlob(makeBlob({ producedAt: 1 })))

    expect(readBootstrapBlob()?.producedAt).toBe(99)
  })

  it('accepts a window global that is still a JSON string', () => {
    ;(globalThis as { __AVSB_BOOTSTRAP__?: unknown }).__AVSB_BOOTSTRAP__ =
      serializeBootstrapBlob(makeBlob({ producedAt: 7 }))

    expect(readBootstrapBlob()?.producedAt).toBe(7)
  })
})

describe('contextFromBlob', () => {
  it('returns the full context, attributes and all', () => {
    // The old provider rebuilt {kind, key} from the summary and threw every
    // attribute away, so client-side evaluation silently targeted nobody.
    expect(contextFromBlob(makeBlob())).toEqual(FULL_CONTEXT)
  })

  it('falls back to the summary when a blob carries no context', () => {
    const blob = makeBlob()
    delete blob.context

    expect(contextFromBlob(blob)).toEqual({ kind: 'user', key: 'user-1' })
  })

  it('returns undefined when there is nothing to go on', () => {
    expect(contextFromBlob(null)).toBeUndefined()
    const empty = makeBlob()
    delete empty.context
    empty.snapshot.contextSummary = []
    expect(contextFromBlob(empty)).toBeUndefined()
  })
})
