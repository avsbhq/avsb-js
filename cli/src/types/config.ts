/**
 * Saved-login and per-run credential shapes.
 *
 * The file on disk is `~/.avsb/config.json`; `lib/config.ts` reads and writes
 * it, `lib/credentials.ts` owns the precedence rules that turn it into an
 * `AvsbSession`.
 */

/**
 * One saved login: an organization plus the personal access token used to
 * reach it. Personal access tokens are user-scoped, so a single token often
 * covers several organizations; a separate entry appears when you log in with
 * a token for a different account.
 */
export interface AvsbStoredLogin {
  orgId: string
  orgName: string
  /** Personal access token, stored in plain text (see AvsbConfig). */
  token: string
}

/**
 * Shape of `~/.avsb/config.json`.
 *
 * Written with 0600 permissions and stored as PLAIN TEXT JSON on every
 * operating system. There is no OS keychain integration, so anything that can
 * read your user account's files can read these tokens. `AVSB_TOKEN` is the
 * way to run the CLI without writing a token to disk.
 */
export interface AvsbConfig {
  /** Config schema version. Bumped when the file layout changes. */
  version: 2
  /** orgId of the login every command uses until `avsb org switch` changes it. */
  activeOrgId: string
  /** Every organization the CLI has a saved token for. */
  logins: AvsbStoredLogin[]
  apiBaseUrl: string
}

/**
 * The credentials one command run actually uses, after the environment
 * variables have been layered over the saved config. `tokenSource` records
 * which one won so commands can say so out loud.
 */
export interface AvsbSession {
  token: string
  /** Empty when the token came from the environment and nothing is saved. */
  orgId: string
  /** Empty when the token came from the environment and nothing is saved. */
  orgName: string
  apiBaseUrl: string
  tokenSource: 'env' | 'config'
}

/** Minimum an `ApiClient` needs. `AvsbSession` satisfies it. */
export interface ApiClientConfig {
  apiBaseUrl: string
  token: string
}
