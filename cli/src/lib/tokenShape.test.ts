import { describe, expect, it } from 'vitest'
import { CREDENTIAL_NAMES, describeTokenProblem } from './tokenShape.js'

describe('credential vocabulary', () => {
  it('matches the platform prefixes exactly', () => {
    // Pinned deliberately: these strings are copied from
    // app/_lib/credentialCopy.ts, which the CLI cannot import. If the platform
    // renames a credential, this test is the reminder to follow.
    expect(CREDENTIAL_NAMES.personalAccessTokenPrefix).toBe('avsb_pat_')
    expect(CREDENTIAL_NAMES.serviceTokenPrefix).toBe('avsb_svc_')
    expect(CREDENTIAL_NAMES.sdkKeyPrefix).toBe('sdk_')
    expect(CREDENTIAL_NAMES.personalAccessTokenTab).toBe('Personal Access Tokens')
  })
})

describe('describeTokenProblem', () => {
  it('accepts a personal access token', () => {
    expect(describeTokenProblem('avsb_pat_abc123')).toBeNull()
  })

  it('names a service token and says what the CLI needs instead', () => {
    const problem = describeTokenProblem('avsb_svc_abc123')

    expect(problem).toContain('service token')
    expect(problem).toContain('avsb_pat_')
    expect(problem).toContain('Account Settings')
  })

  it('explains that an SDK key cannot sign in', () => {
    const problem = describeTokenProblem('sdk_production_abc123')

    expect(problem).toContain('SDK key')
    expect(problem).toContain('cannot sign in')
  })

  it('calls out the old bare pat_ format rather than a generic failure', () => {
    const problem = describeTokenProblem('pat_legacy')

    expect(problem).toContain('old format')
    expect(problem).toContain('avsb_pat_')
  })

  it('answers an empty token with what to supply', () => {
    expect(describeTokenProblem('   ')).toContain('No token supplied')
  })

  it('falls back to naming the expected prefix for anything else', () => {
    expect(describeTokenProblem('hunter2')).toContain('start with avsb_pat_')
  })
})
