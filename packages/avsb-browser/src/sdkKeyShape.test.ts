import { describe, expect, it } from 'vitest'
import { describeSdkKey, validateSdkKeyShape } from './sdkKeyShape'

describe('validateSdkKeyShape', () => {
  it('accepts real key shapes, including environment keys with underscores', () => {
    for (const key of [
      'sdk_production_ttqm0eaj4vth1krcb2xn',
      'sdk_development_abc12345',
      'sdk_staging_eu_ttqm0eaj4vth1krcb2xn',
    ]) {
      expect(validateSdkKeyShape(key)).toEqual({ valid: true, message: null })
    }
  })

  it('rejects the wrong prefixes that four READMEs used to teach', () => {
    for (const key of ['sdk-pub-your-key-here', 'pub_abcdef123456', 'srv_abcdef123456']) {
      const result = validateSdkKeyShape(key)
      expect(result.valid).toBe(false)
      expect(result.message).toContain('never existed')
    }
  })

  it('names the specific mistake for a pasted URL', () => {
    const result = validateSdkKeyShape('https://app.avsb.cloud/projects/p_1/settings')
    expect(result.valid).toBe(false)
    expect(result.message).toContain('looks like a URL')
  })

  it('names the specific mistake for a management-API credential', () => {
    const result = validateSdkKeyShape('avsb_pat_abcdefghijklmnop')
    expect(result.valid).toBe(false)
    // The two names the product uses for these: a personal access token and a
    // service token. Both talk to the management API, neither is an SDK key.
    expect(result.message).toContain('personal access token')
    expect(result.message).toContain('service token')
  })

  it('names whitespace, which is what a copy-paste with a line break produces', () => {
    const result = validateSdkKeyShape(' sdk_production_ttqm0eaj4vth1krcb2xn ')
    expect(result.valid).toBe(false)
    expect(result.message).toContain('whitespace')
  })

  it('reports an empty key as missing entirely', () => {
    const result = validateSdkKeyShape('')
    expect(result.valid).toBe(false)
    expect(result.message).toContain('no SDK key was passed')
  })

  it('always says what the shape is and where the real key lives', () => {
    // Spec §1.2: what failed, the exact value, and the fix location.
    const result = validateSdkKeyShape('nonsense')
    expect(result.message).toContain('nonsense')
    expect(result.message).toContain('sdk_<environment>_<id>')
    expect(result.message).toContain('Environments')
  })

  it('flags a truncated key', () => {
    const result = validateSdkKeyShape('sdk_production_abc')
    expect(result.valid).toBe(false)
    expect(result.message).toContain('truncated')
  })
})

describe('describeSdkKey', () => {
  it('keeps the environment-bearing head and hides the id tail', () => {
    const described = describeSdkKey('sdk_production_ttqm0eaj4vth1krcb2xn')
    expect(described.startsWith('sdk_producti')).toBe(true)
    expect(described).toContain('...')
    expect(described).not.toContain('ttqm0eaj4vth')
  })

  it('leaves short values intact so a truncated key is visible', () => {
    expect(describeSdkKey('sdk_prod')).toBe('sdk_prod')
  })

  it('labels an empty key', () => {
    expect(describeSdkKey('')).toBe('(empty)')
  })
})
