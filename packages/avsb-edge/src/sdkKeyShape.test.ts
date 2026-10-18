// =====================================================================
// sdkKeyShape.ts — key validation at construction (spec §1.2).
//
// Every assertion is on the DIAGNOSIS, not on the fact that a message
// exists: the whole point is that the message tells a developer which of the
// five common mistakes they made.
// =====================================================================

import { describe, it, expect } from 'vitest'
import { describeSdkKey, validateSdkKeyShape } from './sdkKeyShape'
import { VALID_SDK_KEY } from './fixtures'

describe('validateSdkKeyShape', () => {
  it('accepts a real minted key', () => {
    expect(validateSdkKeyShape(VALID_SDK_KEY)).toEqual({ valid: true, message: null })
  })

  it('accepts an environment key that itself contains underscores', () => {
    // Environment keys match /^[a-z][a-z0-9_]*$/, so `staging_eu` is legal and
    // a validator that split on '_' would reject it.
    expect(validateSdkKeyShape('sdk_staging_eu_ttqm0eaj4vth1krcb2xn').valid).toBe(true)
  })

  it('names the missing key when nothing was passed', () => {
    const result = validateSdkKeyShape('')

    expect(result.valid).toBe(false)
    expect(result.message).toContain('no SDK key was passed at all')
    expect(result.message).toContain('(empty)')
  })

  it('recognises a pasted dashboard URL', () => {
    const result = validateSdkKeyShape('https://app.avsb.cloud/projects/1/settings')

    expect(result.message).toContain('looks like a URL, not a key')
  })

  it('recognises an API token in the SDK key field', () => {
    const result = validateSdkKeyShape('avsb_pat_abcdefghijklmnop')

    expect(result.message).toContain('looks like an API token')
    expect(result.message).toContain('management API')
  })

  it('recognises the prefixes that never existed, including the old examples', () => {
    // `sdk-prod-xxx` is what every adapter quickstart printed before this
    // rewrite, so it is the single most likely wrong value in the wild.
    for (const bad of ['sdk-prod-xxx', 'pub_abc123', 'srv_abc123']) {
      expect(validateSdkKeyShape(bad).message).toContain('has never existed in A vs B')
    }
  })

  it('recognises whitespace from a copy-paste', () => {
    const result = validateSdkKeyShape(` ${VALID_SDK_KEY}`)

    expect(result.valid).toBe(false)
    expect(result.message).toContain('leading or trailing whitespace')
  })

  it('recognises a truncated key with no environment segment', () => {
    expect(validateSdkKeyShape('sdk_production').message).toContain('missing the environment segment')
  })

  it('always says where the real key lives', () => {
    const result = validateSdkKeyShape('nonsense')

    expect(result.message).toContain('sdk_<environment>_<id>')
    expect(result.message).toContain('Environments in the project sidebar')
    // N1-17: Environments is its own sidebar item, not a page inside Settings.
    expect(result.message).not.toContain('Settings')
    // And that the SDK proceeds, so a 404 next is explained rather than a mystery.
    expect(result.message).toContain('404s next')
  })
})

describe('describeSdkKey', () => {
  it('keeps the environment half and redacts the generated tail', () => {
    // The environment name is the useful half ("you used the development
    // key"); the cuid2 tail is not, and messages get pasted into bug reports.
    expect(describeSdkKey(VALID_SDK_KEY)).toBe('sdk_producti...b2xn')
  })

  it('reports an empty key as (empty) rather than an empty string', () => {
    expect(describeSdkKey('')).toBe('(empty)')
  })

  it('leaves a short value intact, since there is nothing to hide', () => {
    expect(describeSdkKey('sdk_dev_ab')).toBe('sdk_dev_ab')
  })
})
