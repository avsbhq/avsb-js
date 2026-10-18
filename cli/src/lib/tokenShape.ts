/**
 * Which credential the CLI needs, and how to say so when a different one is
 * pasted in.
 *
 * The platform mints four credentials and only ONE of them signs a CLI request:
 * a personal access token. Pasting a service token or an SDK key is the single
 * most common first-run mistake, and "401 Unauthorized" is a useless answer to
 * it, so the CLI names the credential it got and the credential it wants.
 *
 * The words and prefixes are copied from `app/_lib/credentialCopy.ts`, which is
 * the source of truth for the vocabulary. The CLI ships as its own npm package
 * and cannot import from the app, so `tokenShape.test.ts` pins the strings; if
 * the platform ever renames a credential, that test is the reminder.
 */

export const CREDENTIAL_NAMES = {
  personalAccessToken: 'personal access token',
  personalAccessTokenPrefix: 'avsb_pat_',
  /** Title Case, matching the Account Settings tab it lives on. */
  personalAccessTokenTab: 'Personal Access Tokens',
  serviceToken: 'service token',
  serviceTokenPrefix: 'avsb_svc_',
  sdkKey: 'SDK key',
  sdkKeyPrefix: 'sdk_',
  snippetKey: 'snippet key',
} as const

/** Where a personal access token comes from, in one reusable sentence. */
export const WHERE_TO_GET_A_TOKEN = `Create one in Account Settings > ${CREDENTIAL_NAMES.personalAccessTokenTab}.`

/**
 * Explain why a string cannot be a personal access token, or null when it looks
 * like one.
 *
 * Shape only: a well-formed token can still be revoked or belong to another
 * account, which is what the platform's own 401 is for.
 */
export function describeTokenProblem(token: string): string | null {
  const value = token.trim()

  if (value.length === 0) {
    return `No token supplied. The CLI needs a ${CREDENTIAL_NAMES.personalAccessToken} (${CREDENTIAL_NAMES.personalAccessTokenPrefix}…). ${WHERE_TO_GET_A_TOKEN}`
  }

  if (value.startsWith(CREDENTIAL_NAMES.personalAccessTokenPrefix)) return null

  if (value.startsWith(CREDENTIAL_NAMES.serviceTokenPrefix)) {
    return `That is a ${CREDENTIAL_NAMES.serviceToken} (${CREDENTIAL_NAMES.serviceTokenPrefix}…), which is for organization automation against the REST API. The CLI signs in with a ${CREDENTIAL_NAMES.personalAccessToken} (${CREDENTIAL_NAMES.personalAccessTokenPrefix}…). ${WHERE_TO_GET_A_TOKEN}`
  }

  if (value.startsWith(CREDENTIAL_NAMES.sdkKeyPrefix)) {
    return `That is an ${CREDENTIAL_NAMES.sdkKey} (${CREDENTIAL_NAMES.sdkKeyPrefix}…), which is a public identifier your app uses to read flags. It cannot sign in. The CLI needs a ${CREDENTIAL_NAMES.personalAccessToken} (${CREDENTIAL_NAMES.personalAccessTokenPrefix}…). ${WHERE_TO_GET_A_TOKEN}`
  }

  if (value.startsWith('pat_')) {
    return `Tokens that start with pat_ are the old format and no longer work. Generate a new ${CREDENTIAL_NAMES.personalAccessToken} (${CREDENTIAL_NAMES.personalAccessTokenPrefix}…). ${WHERE_TO_GET_A_TOKEN}`
  }

  return `That does not look like a ${CREDENTIAL_NAMES.personalAccessToken}: they start with ${CREDENTIAL_NAMES.personalAccessTokenPrefix}. ${WHERE_TO_GET_A_TOKEN}`
}
