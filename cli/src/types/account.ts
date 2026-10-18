/**
 * Account-level responses: who a token belongs to, and which organizations it
 * can reach. Both come from the personal-token CLI routes under `/api/cli`.
 */

export interface ApiAuthVerifyResponse {
  data: {
    /** Email of the account the token belongs to. Printed by `avsb whoami`. */
    email: string
    orgId: string
    orgName: string
    /**
     * The role's name, e.g. `DEVELOPER`. Typed loosely because a platform from
     * before the fix sent the whole role record here; `roleName` reads either.
     */
    role: string | { name?: unknown }
  }
}

export interface ApiOrgListResponse {
  data: Array<{
    id: string
    shortId: number
    name: string
  }>
}
