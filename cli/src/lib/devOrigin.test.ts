import { describe, expect, it } from 'vitest'
import { isAllowedDevOrigin } from './devOrigin.js'

describe('isAllowedDevOrigin', () => {
  it('lets a client that sends no Origin connect: it is not a browser', () => {
    expect(isAllowedDevOrigin(undefined)).toBe(true)
    expect(isAllowedDevOrigin('')).toBe(true)
  })

  it('lets pages served from this machine connect, on any port, over http or https', () => {
    for (const origin of [
      'http://localhost',
      'http://localhost:3000',
      'http://127.0.0.1:4400',
      'http://[::1]:5173',
      'https://localhost:8443',
      'HTTP://LOCALHOST:3000',
    ]) {
      expect(isAllowedDevOrigin(origin), origin).toBe(true)
    }
  })

  it('lets the browser extension connect, from the Web Store, an unpacked folder or Firefox', () => {
    expect(isAllowedDevOrigin('chrome-extension://mpgaadhdlbondjlhpgfgffemogbchngm')).toBe(true)
    expect(isAllowedDevOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnop')).toBe(true)
    expect(isAllowedDevOrigin('moz-extension://0c9e4d6a-3b1f-4c2e-9a7d-5f8e1b2c3d4e')).toBe(true)
  })

  it('refuses any other website, which is the attack (2026-10-15 retest)', () => {
    for (const origin of [
      'https://evil.example',
      'http://evil.example',
      'https://app.avsb.cloud',
      'http://localhost.evil.example',
      'http://127.0.0.1.evil.example:4400',
      'http://localhost:3000/path',
      'null',
      'file://',
    ]) {
      expect(isAllowedDevOrigin(origin), origin).toBe(false)
    }
  })

  it('refuses malformed extension origins', () => {
    expect(isAllowedDevOrigin('chrome-extension://short')).toBe(false)
    expect(isAllowedDevOrigin('chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBe(false)
    expect(isAllowedDevOrigin('moz-extension://not-a-uuid')).toBe(false)
    expect(isAllowedDevOrigin('safari-web-extension://anything')).toBe(false)
  })
})
