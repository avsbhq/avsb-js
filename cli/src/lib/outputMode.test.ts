import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  envFlagEnabled,
  isJsonOutput,
  isQuiet,
  resetOutputMode,
  resolveOutputMode,
  setOutputMode,
  writeErr,
  writeOut,
} from './outputMode.js'

afterEach(() => {
  resetOutputMode()
  vi.restoreAllMocks()
})

describe('envFlagEnabled', () => {
  it('accepts the three spellings a shell script is likely to use', () => {
    expect(envFlagEnabled('1')).toBe(true)
    expect(envFlagEnabled('true')).toBe(true)
    expect(envFlagEnabled(' YES ')).toBe(true)
  })

  it('treats anything else, including an empty value, as off', () => {
    expect(envFlagEnabled('0')).toBe(false)
    expect(envFlagEnabled('')).toBe(false)
    expect(envFlagEnabled(undefined)).toBe(false)
  })
})

describe('resolveOutputMode', () => {
  it('is off by default', () => {
    expect(resolveOutputMode({}, {})).toEqual({ json: false, quiet: false })
  })

  it('makes --json imply quiet, so nothing else can corrupt the document', () => {
    expect(resolveOutputMode({ json: true }, {})).toEqual({ json: true, quiet: true })
  })

  it('allows --quiet without --json', () => {
    expect(resolveOutputMode({ quiet: true }, {})).toEqual({ json: false, quiet: true })
  })

  it('reads AVSB_JSON and AVSB_QUIET so a script need not pass flags', () => {
    expect(resolveOutputMode({}, { AVSB_JSON: '1' })).toEqual({ json: true, quiet: true })
    expect(resolveOutputMode({}, { AVSB_QUIET: 'true' })).toEqual({ json: false, quiet: true })
  })
})

describe('stream discipline', () => {
  it('sends results to stdout and notes to stderr', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    writeOut('result')
    writeErr('note')

    expect(out).toHaveBeenCalledWith('result\n')
    expect(err).toHaveBeenCalledWith('note\n')
  })
})

describe('mode state', () => {
  it('reports the mode that was set, and resets', () => {
    setOutputMode({ json: true, quiet: true })
    expect(isJsonOutput()).toBe(true)
    expect(isQuiet()).toBe(true)

    resetOutputMode()
    expect(isJsonOutput()).toBe(false)
    expect(isQuiet()).toBe(false)
  })
})
