import { describe, expect, it } from 'vitest'
import {
  API_URL_ENV_VAR,
  TOKEN_ENV_VAR,
  readEnvApiUrl,
  readEnvToken,
  stripTrailingSlash,
} from './env.js'

describe('readEnvToken', () => {
  it('returns the token when the variable is set', () => {
    expect(readEnvToken({ [TOKEN_ENV_VAR]: 'pat_abc' })).toBe('pat_abc')
  })

  it('trims surrounding whitespace so a copied newline still works', () => {
    expect(readEnvToken({ [TOKEN_ENV_VAR]: '  pat_abc\n' })).toBe('pat_abc')
  })

  it('treats an empty or whitespace-only variable as unset', () => {
    expect(readEnvToken({ [TOKEN_ENV_VAR]: '' })).toBeNull()
    expect(readEnvToken({ [TOKEN_ENV_VAR]: '   ' })).toBeNull()
  })

  it('returns null when the variable is absent', () => {
    expect(readEnvToken({})).toBeNull()
  })
})

describe('readEnvApiUrl', () => {
  it('returns the URL without a trailing slash', () => {
    expect(readEnvApiUrl({ [API_URL_ENV_VAR]: 'http://localhost:3000/' })).toBe(
      'http://localhost:3000',
    )
  })

  it('returns null when the variable is absent or blank', () => {
    expect(readEnvApiUrl({})).toBeNull()
    expect(readEnvApiUrl({ [API_URL_ENV_VAR]: ' ' })).toBeNull()
  })
})

describe('stripTrailingSlash', () => {
  it('removes exactly one trailing slash', () => {
    expect(stripTrailingSlash('https://app.avsb.cloud/')).toBe('https://app.avsb.cloud')
  })

  it('leaves a URL without a trailing slash untouched', () => {
    expect(stripTrailingSlash('https://app.avsb.cloud')).toBe('https://app.avsb.cloud')
  })
})
