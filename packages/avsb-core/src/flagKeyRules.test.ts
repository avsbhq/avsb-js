import {
  FLAG_KEY_MAX_LENGTH,
  flagNotFoundMessage,
  isPlatformFlagKey,
  suggestFlagKey,
} from './flagKeyRules'

describe('isPlatformFlagKey', () => {
  it('accepts the keys the platform creates', () => {
    expect(isPlatformFlagKey('checkout_v2')).toBe(true)
    expect(isPlatformFlagKey('a')).toBe(true)
  })

  it('refuses hyphens, capitals, spaces and a leading digit, as the platform does', () => {
    expect(isPlatformFlagKey('checkout-v2')).toBe(false)
    expect(isPlatformFlagKey('Checkout')).toBe(false)
    expect(isPlatformFlagKey('dark mode')).toBe(false)
    expect(isPlatformFlagKey('2fa')).toBe(false)
    expect(isPlatformFlagKey('')).toBe(false)
  })

  it('refuses a key over the length limit', () => {
    expect(isPlatformFlagKey('a'.repeat(FLAG_KEY_MAX_LENGTH))).toBe(true)
    expect(isPlatformFlagKey('a'.repeat(FLAG_KEY_MAX_LENGTH + 1))).toBe(false)
  })
})

describe('suggestFlagKey', () => {
  it('suggests the underscore spelling for the docs examples the QA found', () => {
    expect(suggestFlagKey('new-checkout-flow')).toBe('new_checkout_flow')
    expect(suggestFlagKey('dark-mode')).toBe('dark_mode')
    expect(suggestFlagKey('Dark Mode')).toBe('dark_mode')
    expect(suggestFlagKey('checkout.v2')).toBe('checkout_v2')
  })

  it('suggests nothing for a valid key or one with no obvious fix', () => {
    expect(suggestFlagKey('checkout_v2')).toBeNull()
    expect(suggestFlagKey('2fa-enabled')).toBeNull()
    expect(suggestFlagKey('---')).toBeNull()
  })
})

describe('flagNotFoundMessage', () => {
  it('says the key is missing, not that its type is wrong', () => {
    const message = flagNotFoundMessage('checkout_v3')
    expect(message).toContain('"checkout_v3" is not in this environment\'s datafile')
    expect(message).toContain('source "not_found"')
    expect(message).not.toMatch(/getter|declared as/)
  })

  it('suggests the platform spelling for a hyphenated key', () => {
    expect(flagNotFoundMessage('new-checkout-flow')).toContain('did you mean "new_checkout_flow"?')
  })

  it('names the snapshot when that is where the read looked', () => {
    expect(flagNotFoundMessage('checkout_v3', 'snapshot')).toContain(
      'is not in the server bootstrap snapshot'
    )
  })

  it('uses no em-dash, per the copy rules', () => {
    for (const message of [
      flagNotFoundMessage('a_b'),
      flagNotFoundMessage('a-b'),
      flagNotFoundMessage('2-b'),
      flagNotFoundMessage('a_b', 'snapshot'),
    ]) {
      expect(message.includes('—')).toBe(false)
    }
  })
})
