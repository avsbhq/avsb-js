/**
 * The CLI's client for the PUBLIC API (`/api/v1`), which is where the feature
 * flag lifecycle and the public experiment list live.
 *
 * These are the only calls that leave `/api/cli`. A personal access token
 * (`avsb_pat_…`) authenticates on the public API too and is granted the
 * permissions of your role in the organization, so `avsb flags` needs no second
 * credential and no extra setup.
 *
 * Path ids may be a numeric short id (`42`) or a cuid: the public API resolves
 * both, always scoped to the token's organization, and answers 404 for anything
 * outside it.
 *
 * Split from `api.ts` to keep both files inside the size limit; the transport,
 * headers and error handling are inherited, not copied.
 */

import { ApiClient } from './api.js'
import type { ApiResult } from './apiTransport.js'
import type { CliPublicExperiment } from '../types/experiment.js'
import type { CliListPage } from '../types/pagination.js'
import type {
  ApiFlagEnvTransitionResponse,
  ApiFlagListResponse,
  ApiFlagResponse,
  CreateFlagBody,
  UpdateFlagBody,
} from '../types/flag.js'

/**
 * The header the conditional-write token travels on.
 *
 * Deliberately NOT the standard `If-Match`. The API is served from behind an
 * edge network (Vercel) that intercepts `If-Match` on these routes and re-checks
 * the precondition against the RESPONSE's ETag, which always differs after a
 * write. Proven on staging: the exact current token reaches the handler, the
 * write executes and persists, and the caller still receives the edge's own
 * plain-text 412. So every SUCCESSFUL conditional write looked like a failure,
 * and nothing local ever saw it because there is no edge in front of a test.
 *
 * `app/_lib/api/ifMatchHeader.ts` holds the canonical constant and the full
 * write-up. This is a deliberate copy of the literal, not an import: the CLI is
 * a separately published package and must not reach into the app tree. If the
 * name changes there, change it here in the same step.
 *
 * The server still reads plain `If-Match` as a fallback, so an older CLI keeps
 * working. It just keeps hitting the edge.
 */
const IF_MATCH_HEADER = 'X-Avsb-If-Match'

export class FlagsApiClient extends ApiClient {
  private v1Project(projectRef: string | number): string {
    return `/api/v1/projects/${encodeURIComponent(String(projectRef))}`
  }

  private listQuery(opts: { limit?: number; cursor?: string }): string {
    const params = new URLSearchParams()
    if (opts.limit != null) params.set('limit', String(opts.limit))
    if (opts.cursor) params.set('cursor', opts.cursor)
    const qs = params.toString()
    return qs ? `?${qs}` : ''
  }

  async listFlags(
    projectRef: string | number,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<ApiFlagListResponse> {
    return this.request<ApiFlagListResponse>(
      `${this.v1Project(projectRef)}/flags${this.listQuery(opts)}`,
    )
  }

  /**
   * One flag, WITH its ETag. The ETag is what makes a safe update possible:
   * `avsb flags update` sends it back on the conditional-write header, so a
   * change someone else made between the read and the write is refused (412)
   * instead of silently overwritten.
   */
  async getFlag(
    projectRef: string | number,
    flagRef: string,
  ): Promise<ApiResult<ApiFlagResponse>> {
    return this.requestWithMeta<ApiFlagResponse>(
      `${this.v1Project(projectRef)}/flags/${encodeURIComponent(flagRef)}`,
    )
  }

  async createFlag(
    projectRef: string | number,
    body: CreateFlagBody,
  ): Promise<ApiFlagResponse> {
    return this.request<ApiFlagResponse>(`${this.v1Project(projectRef)}/flags`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  /**
   * Update a flag's metadata. `ifMatch` is the ETag from the read this update is
   * based on; it is left out only when the caller deliberately asked to write
   * unconditionally.
   */
  async updateFlag(
    projectRef: string | number,
    flagRef: string,
    patch: UpdateFlagBody,
    ifMatch?: string | null,
  ): Promise<ApiResult<ApiFlagResponse>> {
    // `requestWithMeta`, not `request`: when the route starts returning the new
    // ETag, `avsb flags update --json` surfaces it without another round trip.
    // Today it sends none, and `meta.etag` is simply absent.
    return this.requestWithMeta<ApiFlagResponse>(
      `${this.v1Project(projectRef)}/flags/${encodeURIComponent(flagRef)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
        headers: ifMatch ? { [IF_MATCH_HEADER]: ifMatch } : {},
      },
    )
  }

  /**
   * Start or stop serving one environment's rules. Idempotent on the platform
   * side: asking for the state it is already in answers 200 with
   * `changed: false`, so a CI kill switch can be fired blind.
   */
  async setFlagEnvState(
    projectRef: string | number,
    flagRef: string,
    envId: string,
    action: 'run' | 'pause',
  ): Promise<ApiFlagEnvTransitionResponse> {
    return this.request<ApiFlagEnvTransitionResponse>(
      `${this.v1Project(projectRef)}/flags/${encodeURIComponent(flagRef)}/envs/${encodeURIComponent(envId)}/${action}`,
      { method: 'POST' },
    )
  }

  async listExperiments(
    projectRef: string | number,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<{ data: CliPublicExperiment[]; page: CliListPage }> {
    return this.request<{ data: CliPublicExperiment[]; page: CliListPage }>(
      `${this.v1Project(projectRef)}/experiments${this.listQuery(opts)}`,
    )
  }
}
