/**
 * Environment variables the CLI reads, so it can run with no saved login at
 * all (CI, containers, one-off scripts).
 *
 * Precedence, documented in content/docs/developer-reference/cli-authentication.mdx
 * and applied in `credentials.resolveSession` + `ApiClient`:
 *
 *   token:    AVSB_TOKEN        beats the token in ~/.avsb/config.json
 *   base URL: AVSB_API_URL      beats the URL in ~/.avsb/config.json,
 *                               which beats https://app.avsb.cloud
 *
 * Both variables are read fresh on every call rather than captured at import
 * time, so tests (and anything that sets them programmatically) see changes.
 */

/** Personal access token used for every request when set. */
export const TOKEN_ENV_VAR = 'AVSB_TOKEN'

/** Platform base URL override, mainly for local development. */
export const API_URL_ENV_VAR = 'AVSB_API_URL'

/** Where the CLI talks when nothing else says otherwise. */
export const DEFAULT_API_BASE_URL = 'https://app.avsb.cloud'

/**
 * Where SDKs fetch datafiles from. The CLI never calls it; the name is here so
 * `avsb init` can tell a developer which host their firewall has to allow when
 * no check-in arrives. Not configurable: an SDK reads its endpoints from the
 * datafile, not from this.
 */
export const DEFAULT_CDN_BASE_URL = 'https://cdn.avsb.cloud'

/** Trim a variable and treat blank as unset. */
function readVar(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function readEnvToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return readVar(env, TOKEN_ENV_VAR)
}

export function readEnvApiUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = readVar(env, API_URL_ENV_VAR)
  return url ? stripTrailingSlash(url) : null
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, '')
}
