/**
 * The hydrator's blob, and the stored XSS it used to carry.
 *
 * The headline case is `escapes a script-closing payload`: a flag whose
 * variation value ends the script block. Variation values are authored in
 * the dashboard, so before the escape landed, any org member could put a
 * script on every page of every customer app using the hydrator.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { AvsbHydrator, serializeBootstrapBlob } from './AvsbHydrator'
import type { AvsbBootstrapBlob } from './AvsbHydrator'
import type { EvalContext, FlagDatafile } from '@avsbhq/core'

const USER_CTX: EvalContext = { kind: 'user', key: 'user-1', plan: 'pro' }

// Built from pieces so this file never contains a literal script-closing
// sequence of its own.
const CLOSE_SCRIPT = `</${'script'}>`
const HOSTILE_VALUE = `${CLOSE_SCRIPT}<${'script'}>window.__pwned=1</${'script'}>`

// The two Unicode line terminators, spelled by code point so the source of
// this file stays plain ASCII.
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)

function makeDatafile(value: unknown = false): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: 'sdk_production_hydrator0000',
    environmentKey: 'production',
    publishedAt: '2026-06-01T00:00:00.000Z',
    collectEndpoint: 'https://collect.test.invalid',
    flags: [
      {
        id: 'flag-banner',
        key: 'banner-copy',
        type: typeof value === 'string' ? 'string' : 'boolean',
        enabled: true,
        defaultVariationId: 'var-on',
        variations: [{ id: 'var-on', key: 'on', value }],
        overrides: [],
        rules: [],
      },
    ],
    audiences: [],
  }
}

/** The exact text the browser would put inside the script element. */
function scriptContents(html: string): string {
  const match = html.match(/<script[^>]*id="__AVSB_BOOTSTRAP__"[^>]*>([\s\S]*?)<\/script>/)
  if (!match) throw new Error(`no bootstrap script in: ${html}`)
  return match[1]
}

function parseBlob(html: string): AvsbBootstrapBlob {
  return JSON.parse(scriptContents(html)) as AvsbBootstrapBlob
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('serializeBootstrapBlob', () => {
  function blobCarrying(value: string): AvsbBootstrapBlob {
    return {
      format: 'avsb-bootstrap-v1',
      snapshot: {
        capturedAt: 0,
        datafileVersion: '2026-06-01T00:00:00.000Z',
        flags: {},
        contextSummary: [],
      },
      producedAt: 0,
      context: { kind: 'user', key: value },
    }
  }

  it('escapes every < so a script-closing payload cannot end the block', () => {
    const json = serializeBootstrapBlob(blobCarrying(HOSTILE_VALUE))

    expect(json).not.toContain('<')
    expect(json.toLowerCase()).not.toContain(CLOSE_SCRIPT)
    expect(json).toContain('\\u003c')
  })

  it('round-trips through JSON.parse unchanged after escaping', () => {
    const json = serializeBootstrapBlob(blobCarrying(HOSTILE_VALUE))
    const parsed = JSON.parse(json) as AvsbBootstrapBlob

    // The escape is a JSON escape, so the value a consumer reads is the
    // original one, character for character.
    expect((parsed.context as { key: string }).key).toBe(HOSTILE_VALUE)
  })

  it('escapes the Unicode line separators, which are legal JSON but break JS', () => {
    const value = `a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c`
    const json = serializeBootstrapBlob(blobCarrying(value))

    expect(json).not.toContain(LINE_SEPARATOR)
    expect(json).not.toContain(PARAGRAPH_SEPARATOR)
    expect(json).toContain('\\u2028')
    expect(json).toContain('\\u2029')
    expect((JSON.parse(json) as AvsbBootstrapBlob).context).toEqual({
      kind: 'user',
      key: value,
    })
  })
})

describe('AvsbHydrator', () => {
  it('emits no raw < for a flag value that closes the script block', async () => {
    const element = await AvsbHydrator({
      datafile: makeDatafile(HOSTILE_VALUE),
      context: USER_CTX,
    })
    const html = renderToString(element)
    const contents = scriptContents(html)

    // The regression: before the escape, this substring appeared verbatim
    // in the page and the browser executed everything after it.
    expect(contents).not.toContain('<')
    expect(html.toLowerCase().indexOf(CLOSE_SCRIPT)).toBe(
      html.toLowerCase().lastIndexOf(CLOSE_SCRIPT),
    )

    const blob = JSON.parse(contents) as AvsbBootstrapBlob
    expect(blob.snapshot.flags['banner-copy']?.value).toBe(HOSTILE_VALUE)
  })

  it('carries the datafile by default, so the browser makes no first fetch', async () => {
    const element = await AvsbHydrator({ datafile: makeDatafile(), context: USER_CTX })
    const blob = parseBlob(renderToString(element))

    expect(blob.datafile?.sdkKey).toBe('sdk_production_hydrator0000')
  })

  it('omits the datafile when the caller passes it another way', async () => {
    const element = await AvsbHydrator({
      datafile: makeDatafile(),
      context: USER_CTX,
      includeDatafile: false,
    })
    const blob = parseBlob(renderToString(element))

    expect(blob.datafile).toBeUndefined()
    // The evaluated values are still there: that is the point of the blob.
    expect(Object.keys(blob.snapshot.flags)).toContain('banner-copy')
  })

  it('carries the full context, attributes included', async () => {
    const element = await AvsbHydrator({ datafile: makeDatafile(), context: USER_CTX })
    const blob = parseBlob(renderToString(element))

    // The old blob carried only {kind, key} in contextSummary, so every
    // targeting attribute was lost on the way to the client.
    expect(blob.context).toEqual(USER_CTX)
    expect(blob.snapshot.contextSummary).toEqual([{ kind: 'user', key: 'user-1' }])
  })

  it('serialises flags as data, with no functions to lose', async () => {
    const element = await AvsbHydrator({ datafile: makeDatafile(true), context: USER_CTX })
    const blob = parseBlob(renderToString(element))
    const flag = blob.snapshot.flags['banner-copy']

    expect(flag).toBeDefined()
    expect(flag?.value).toBe(true)
    expect(flag?.source).toBe('default')
    expect(Array.isArray(flag?.reasons)).toBe(true)
  })

  it('summarises every kind of a multi-context', async () => {
    const multi: EvalContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'user-42' },
      org: { kind: 'org', key: 'org-1' },
    }
    const element = await AvsbHydrator({ datafile: makeDatafile(), context: multi })
    const blob = parseBlob(renderToString(element))

    expect(blob.snapshot.contextSummary).toEqual([
      { kind: 'user', key: 'user-42' },
      { kind: 'org', key: 'org-1' },
    ])
  })

  it('names the fix when neither a datafile nor an sdkKey is given', async () => {
    await expect(
      AvsbHydrator({ context: USER_CTX } as Parameters<typeof AvsbHydrator>[0]),
    ).rejects.toThrow(/needs either a `datafile` or an `sdkKey`/)
  })
})
