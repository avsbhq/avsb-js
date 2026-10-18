/**
 * Pure logic for the CLI's saved-credentials document (`~/.avsb/config.json`)
 * and for deciding which credentials a command run should use.
 *
 * No filesystem access lives here on purpose: `config.ts` owns reading and
 * writing the file, this module owns the shape, the environment-over-file
 * precedence, and the multi-organization bookkeeping `avsb org switch` needs.
 * That split is what makes all of it unit-testable.
 */

import {
  DEFAULT_API_BASE_URL,
  TOKEN_ENV_VAR,
  stripTrailingSlash,
} from './env.js'
import type {
  AvsbConfig,
  AvsbSession,
  AvsbStoredLogin,
} from '../types/config.js'

/** Schema version written into every config file this CLI saves. */
export const CONFIG_VERSION = 2

export type ConfigReadResult =
  | { status: 'ok'; config: AvsbConfig }
  | { status: 'missing' }
  | { status: 'unreadable'; detail: string }

export interface EnvOverrides {
  token: string | null
  apiBaseUrl: string | null
}

export type SessionResult =
  | { status: 'ok'; session: AvsbSession; warning?: string }
  | { status: 'no-credentials' }
  | { status: 'unreadable'; detail: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isStoredLogin(value: unknown): value is AvsbStoredLogin {
  return (
    isRecord(value) &&
    isNonEmptyString(value.orgId) &&
    typeof value.orgName === 'string' &&
    isNonEmptyString(value.token)
  )
}

/**
 * Parse the raw contents of the config file. Anything unexpected comes back as
 * `unreadable` with a plain-English reason the caller can print, rather than
 * throwing or silently pretending the user is logged out.
 */
export function parseConfigDocument(raw: string): ConfigReadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'unreadable', detail: 'it is not valid JSON' }
  }

  if (!isRecord(parsed)) {
    return { status: 'unreadable', detail: 'it does not contain a JSON object' }
  }

  if (parsed.version !== CONFIG_VERSION) {
    return {
      status: 'unreadable',
      detail:
        parsed.version === undefined
          ? 'it was written by an older version of the CLI'
          : `its format (version ${String(parsed.version)}) is not supported by this CLI`,
    }
  }

  if (!Array.isArray(parsed.logins)) {
    return { status: 'unreadable', detail: 'its list of saved logins is missing' }
  }

  const logins: AvsbStoredLogin[] = []
  for (const candidate of parsed.logins) {
    if (!isStoredLogin(candidate)) {
      return { status: 'unreadable', detail: 'one of its saved logins is incomplete' }
    }
    logins.push({
      orgId: candidate.orgId,
      orgName: candidate.orgName,
      token: candidate.token,
    })
  }

  if (logins.length === 0) {
    return { status: 'unreadable', detail: 'it has no saved logins' }
  }

  return {
    status: 'ok',
    config: {
      version: CONFIG_VERSION,
      activeOrgId: typeof parsed.activeOrgId === 'string' ? parsed.activeOrgId : '',
      logins,
      apiBaseUrl: isNonEmptyString(parsed.apiBaseUrl)
        ? stripTrailingSlash(parsed.apiBaseUrl)
        : DEFAULT_API_BASE_URL,
    },
  }
}

export function findLogin(
  config: AvsbConfig,
  orgId: string,
): AvsbStoredLogin | undefined {
  return config.logins.find((login) => login.orgId === orgId)
}

/**
 * Decide which token and base URL this command run uses.
 *
 * `AVSB_TOKEN` wins over the saved token, and `AVSB_API_URL` wins over the
 * saved base URL, so a CI job needs no config file at all. A config file that
 * cannot be read is not fatal when the environment supplies a token.
 */
export function resolveSession(
  read: ConfigReadResult,
  env: EnvOverrides,
): SessionResult {
  if (read.status === 'ok') {
    const { config } = read
    const exactMatch = findLogin(config, config.activeOrgId)
    const active = exactMatch ?? config.logins[0]

    return {
      status: 'ok',
      session: {
        token: env.token ?? active.token,
        orgId: active.orgId,
        orgName: active.orgName,
        apiBaseUrl: env.apiBaseUrl ?? config.apiBaseUrl,
        tokenSource: env.token ? 'env' : 'config',
      },
      warning: exactMatch
        ? undefined
        : `Your saved active organization is no longer in the config file. Using ${active.orgName}. Run \`avsb org switch\` to choose one.`,
    }
  }

  if (env.token) {
    return {
      status: 'ok',
      session: {
        token: env.token,
        orgId: '',
        orgName: '',
        apiBaseUrl: env.apiBaseUrl ?? DEFAULT_API_BASE_URL,
        tokenSource: 'env',
      },
    }
  }

  if (read.status === 'missing') return { status: 'no-credentials' }
  return { status: 'unreadable', detail: read.detail }
}

/**
 * Add or replace one organization's saved login and make it the active one.
 * Existing entries keep their position so `avsb org list` stays stable.
 */
export function upsertLogin(
  config: AvsbConfig | null,
  entry: AvsbStoredLogin,
  apiBaseUrl: string,
): AvsbConfig {
  const existing = config?.logins ?? []
  const logins = existing.some((login) => login.orgId === entry.orgId)
    ? existing.map((login) => (login.orgId === entry.orgId ? entry : login))
    : [...existing, entry]

  return {
    version: CONFIG_VERSION,
    activeOrgId: entry.orgId,
    logins,
    apiBaseUrl: stripTrailingSlash(apiBaseUrl),
  }
}

/** An organization the CLI can switch to, from the platform and/or the config. */
export interface OrgCandidate {
  id: string
  /** Null for organizations known only from a saved login. */
  shortId: number | null
  name: string
  /** True when a token for this organization is saved locally. */
  saved: boolean
  /** True when this is the organization commands currently use. */
  active: boolean
}

/**
 * Merge the organizations the active token can reach with the ones the config
 * has saved tokens for. Platform order is preserved; saved-only organizations
 * (reachable with another account's token) are appended.
 */
export function buildOrgCandidates(
  config: AvsbConfig,
  apiOrgs: Array<{ id: string; shortId: number; name: string }>,
): OrgCandidate[] {
  const byId = new Map<string, OrgCandidate>()

  for (const org of apiOrgs) {
    byId.set(org.id, {
      id: org.id,
      shortId: org.shortId,
      name: org.name,
      saved: false,
      active: false,
    })
  }

  for (const login of config.logins) {
    const existing = byId.get(login.orgId)
    if (existing) {
      existing.saved = true
      if (!existing.name) existing.name = login.orgName
      continue
    }
    byId.set(login.orgId, {
      id: login.orgId,
      shortId: null,
      name: login.orgName,
      saved: true,
      active: false,
    })
  }

  const active = byId.get(config.activeOrgId)
  if (active) active.active = true

  return [...byId.values()]
}

/**
 * Resolve what the user typed after `avsb org switch`: a numeric short id
 * (`42` or `ORG-42`), the organization's id, or its name (case-insensitive).
 */
export function matchOrgCandidate(
  candidates: OrgCandidate[],
  needle: string,
): OrgCandidate | null {
  const trimmed = needle.trim()
  if (trimmed.length === 0) return null

  const numeric = trimmed.replace(/^org-/i, '')
  if (/^\d+$/.test(numeric)) {
    const shortId = Number(numeric)
    return candidates.find((c) => c.shortId === shortId) ?? null
  }

  const byId = candidates.find((c) => c.id === trimmed)
  if (byId) return byId

  const lowered = trimmed.toLowerCase()
  return candidates.find((c) => c.name.toLowerCase() === lowered) ?? null
}

/**
 * Make one organization active, saving a login for it when there isn't one
 * yet. Personal access tokens are user-scoped, so the token that listed the
 * organization is the token that can reach it.
 */
export function activateOrg(
  config: AvsbConfig,
  candidate: OrgCandidate,
  fallbackToken: string,
): AvsbConfig {
  const existing = findLogin(config, candidate.id)
  return upsertLogin(
    config,
    {
      orgId: candidate.id,
      orgName: candidate.name,
      token: existing?.token ?? fallbackToken,
    },
    config.apiBaseUrl,
  )
}

/** Human-readable answer to "where did this token come from?". */
export function describeTokenSource(
  session: AvsbSession,
  configPath: string,
): string {
  return session.tokenSource === 'env'
    ? `${TOKEN_ENV_VAR} environment variable`
    : configPath
}
