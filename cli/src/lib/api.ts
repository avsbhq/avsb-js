/**
 * The CLI's client for the personal-token routes under `/api/cli`: auth,
 * organizations, experiments, project scripts, datafiles, metrics, metric
 * bindings and datasets.
 *
 * Transport (credentials, headers, error shapes) lives in `apiTransport.ts`;
 * the public-API flag and experiment calls live in `flagsApi.ts`. Both are
 * separate files because this one is at its size limit.
 */

import { ApiTransport } from './apiTransport.js'
import { describeNetworkFailure } from './networkError.js'
import type { ApiExperimentResponse, ExperimentStatus } from '../types/experiment.js'
import type { ApiProjectResponse } from '../types/project.js'
import type { ApiAuthVerifyResponse, ApiOrgListResponse } from '../types/account.js'
import type {
  ApiMetricResponse,
  ApiMetricListResponse,
  ApiMetricDeleteResponse,
  CliMetricType,
  CreateMetricBody,
  UpdateMetricBody,
} from '../types/metric.js'
import type {
  ApiMetricBindingResponse,
  ApiMetricBindingListResponse,
  ApiMetricBindingDeleteResponse,
  CreateMetricBindingBody,
  UpdateMetricBindingBody,
} from '../types/metricBinding.js'
import type {
  ApiDatasetListResponse,
  ApiDatasetDetailResponse,
  ApiDatasetVersionCreateResponse,
  ApiDatasetVersionResponse,
  ApiDatasetActivateResponse,
} from '../types/dataset.js'

export class ApiClient extends ApiTransport {
  /**
   * Confirm the token and report the account it belongs to. Pass `orgId` to ask
   * about one organization (so `avsb whoami` prints the role in the active one);
   * without it the platform answers with the account's first organization.
   */
  async verifyAuth(orgId?: string): Promise<ApiAuthVerifyResponse> {
    const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
    return this.request<ApiAuthVerifyResponse>(`/api/cli/auth/verify${query}`)
  }

  async listOrgs(): Promise<ApiOrgListResponse> {
    return this.request<ApiOrgListResponse>('/api/cli/orgs')
  }

  async getExperiment(shortId: number): Promise<ApiExperimentResponse> {
    return this.request<ApiExperimentResponse>(`/api/cli/experiments/${shortId}`)
  }

  async pushExperiment(
    shortId: number,
    data: {
      triggersJs?: { source: string; compiled: string }
      variations?: Array<{
        id: string
        controlJs?: { source: string; compiled: string }
        controlCss?: { source: string; compiled: string }
      }>
    }
  ): Promise<{ data: { success: boolean; hasPendingChanges: boolean; status?: ExperimentStatus } }> {
    return this.request(`/api/cli/experiments/${shortId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  }

  /**
   * Publish an experiment's pending changes, as the dashboard's Publish
   * changes button does. `warning` is set when the change is saved but the
   * live datafile could not be written yet (the platform retries it).
   */
  async publishChanges(shortId: number): Promise<{
    data: { success: boolean; published?: boolean; warning?: { code: string; message: string } }
  }> {
    return this.request(`/api/cli/experiments/${shortId}/publish`, {
      method: 'POST',
    })
  }

  async getProject(shortId: number): Promise<ApiProjectResponse> {
    return this.request<ApiProjectResponse>(`/api/cli/projects/${shortId}`)
  }

  async pushProject(
    shortId: number,
    data: {
      editorProjectJs?: { source: string; compiled: string }
      editorProjectTs?: { source: string; compiled: string }
    }
  ): Promise<{ data: { success: boolean } }> {
    return this.request(`/api/cli/projects/${shortId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  }

  /**
   * Fetch a project's published datafile for a given environment.
   *
   * Used by `avsb codegen` to generate the typed `FlagKey` / `FlagValues` /
   * `ContextSchema` interfaces from the live flag definitions.
   */
  async getDatafile(
    projectShortId: number,
    environment: string
  ): Promise<{
    flags: Array<{
      key: string
      type: 'boolean' | 'string' | 'number' | 'json'
      variations: Array<{ value: unknown }>
    }>
    contextKinds?: string[]
    registeredAttributes?:
      | Array<{ key: string; type: string; contextKind?: string }>
      | string[]
    publishedAt?: string | null
  }> {
    return this.request(
      `/api/cli/projects/${projectShortId}/datafile?env=${encodeURIComponent(environment)}`
    )
  }

  // ── Metrics (tracking definitions) ────────────────────────

  async listMetrics(
    projectShortId: number,
    opts: { type?: CliMetricType; includeArchived?: boolean } = {},
  ): Promise<ApiMetricListResponse> {
    const params = new URLSearchParams()
    if (opts.type) params.set('type', opts.type)
    if (opts.includeArchived) params.set('includeArchived', 'true')
    const qs = params.toString()
    const path = `/api/cli/projects/${projectShortId}/metrics${qs ? `?${qs}` : ''}`
    return this.request<ApiMetricListResponse>(path)
  }

  async createMetric(
    projectShortId: number,
    body: CreateMetricBody,
  ): Promise<ApiMetricResponse> {
    return this.request<ApiMetricResponse>(
      `/api/cli/projects/${projectShortId}/metrics`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    )
  }

  async updateMetric(
    projectShortId: number,
    metricId: string,
    patch: UpdateMetricBody,
  ): Promise<ApiMetricResponse> {
    return this.request<ApiMetricResponse>(
      `/api/cli/projects/${projectShortId}/metrics/${encodeURIComponent(metricId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
      },
    )
  }

  async archiveMetric(
    projectShortId: number,
    metricId: string,
  ): Promise<ApiMetricResponse> {
    return this.request<ApiMetricResponse>(
      `/api/cli/projects/${projectShortId}/metrics/${encodeURIComponent(metricId)}/archive`,
      { method: 'POST' },
    )
  }

  async unarchiveMetric(
    projectShortId: number,
    metricId: string,
  ): Promise<ApiMetricResponse> {
    return this.request<ApiMetricResponse>(
      `/api/cli/projects/${projectShortId}/metrics/${encodeURIComponent(metricId)}/unarchive`,
      { method: 'POST' },
    )
  }

  async deleteMetric(
    projectShortId: number,
    metricId: string,
  ): Promise<ApiMetricDeleteResponse> {
    return this.request<ApiMetricDeleteResponse>(
      `/api/cli/projects/${projectShortId}/metrics/${encodeURIComponent(metricId)}`,
      { method: 'DELETE' },
    )
  }

  // ── Metric bindings (analysis-side wrappers) ──────────────

  async listMetricBindings(
    projectShortId: number,
    opts: { library?: boolean; search?: string; includeArchived?: boolean; limit?: number } = {},
  ): Promise<ApiMetricBindingListResponse> {
    const params = new URLSearchParams()
    if (opts.library) params.set('library', 'true')
    if (opts.search) params.set('search', opts.search)
    if (opts.includeArchived) params.set('includeArchived', 'true')
    if (opts.limit != null) params.set('limit', String(opts.limit))
    const qs = params.toString()
    const path = `/api/cli/projects/${projectShortId}/metric-bindings${qs ? `?${qs}` : ''}`
    return this.request<ApiMetricBindingListResponse>(path)
  }

  async createMetricBinding(
    projectShortId: number,
    body: CreateMetricBindingBody,
  ): Promise<ApiMetricBindingResponse> {
    return this.request<ApiMetricBindingResponse>(
      `/api/cli/projects/${projectShortId}/metric-bindings`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    )
  }

  async updateMetricBinding(
    projectShortId: number,
    metricBindingId: string,
    patch: UpdateMetricBindingBody,
  ): Promise<ApiMetricBindingResponse> {
    return this.request<ApiMetricBindingResponse>(
      `/api/cli/projects/${projectShortId}/metric-bindings/${encodeURIComponent(metricBindingId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
      },
    )
  }

  async archiveMetricBinding(
    projectShortId: number,
    metricBindingId: string,
  ): Promise<ApiMetricBindingResponse> {
    return this.request<ApiMetricBindingResponse>(
      `/api/cli/projects/${projectShortId}/metric-bindings/${encodeURIComponent(metricBindingId)}/archive`,
      { method: 'POST' },
    )
  }

  async unarchiveMetricBinding(
    projectShortId: number,
    metricBindingId: string,
  ): Promise<ApiMetricBindingResponse> {
    return this.request<ApiMetricBindingResponse>(
      `/api/cli/projects/${projectShortId}/metric-bindings/${encodeURIComponent(metricBindingId)}/unarchive`,
      { method: 'POST' },
    )
  }

  async deleteMetricBinding(
    projectShortId: number,
    metricBindingId: string,
  ): Promise<ApiMetricBindingDeleteResponse> {
    return this.request<ApiMetricBindingDeleteResponse>(
      `/api/cli/projects/${projectShortId}/metric-bindings/${encodeURIComponent(metricBindingId)}`,
      { method: 'DELETE' },
    )
  }

  // ── Datasets (server-side datasets, e-commerce suite Phase 2) ──
  //
  // These call the personal-token CLI proxy routes
  // `/api/cli/projects/{shortId}/datasets/...`, which resolve the project
  // by short id exactly like the metrics routes above and mirror the
  // org-scoped dashboard routes' response envelopes
  // (_specs/ecommerce-suite-spec.md §2.5).

  private datasetsBase(projectShortId: number): string {
    return `/api/cli/projects/${projectShortId}/datasets`
  }

  async listDatasets(projectShortId: number): Promise<ApiDatasetListResponse> {
    return this.request<ApiDatasetListResponse>(this.datasetsBase(projectShortId))
  }

  /** Dataset detail — includes the full version list. */
  async getDataset(
    projectShortId: number,
    datasetId: string,
  ): Promise<ApiDatasetDetailResponse> {
    return this.request<ApiDatasetDetailResponse>(
      `${this.datasetsBase(projectShortId)}/${datasetId}`,
    )
  }

  async createDatasetVersion(
    projectShortId: number,
    datasetId: string,
    body: { label?: string } = {},
  ): Promise<ApiDatasetVersionCreateResponse> {
    return this.request<ApiDatasetVersionCreateResponse>(
      `${this.datasetsBase(projectShortId)}/${datasetId}/versions`,
      { method: 'POST', body: JSON.stringify(body) },
    )
  }

  async commitDatasetVersion(
    projectShortId: number,
    datasetId: string,
    versionId: string,
  ): Promise<ApiDatasetVersionResponse> {
    return this.request<ApiDatasetVersionResponse>(
      `${this.datasetsBase(projectShortId)}/${datasetId}/versions/${versionId}/commit`,
      { method: 'POST' },
    )
  }

  async activateDatasetVersion(
    projectShortId: number,
    datasetId: string,
    versionId: string,
  ): Promise<ApiDatasetActivateResponse> {
    return this.request<ApiDatasetActivateResponse>(
      `${this.datasetsBase(projectShortId)}/${datasetId}/versions/${versionId}/activate`,
      { method: 'POST' },
    )
  }

  /**
   * Upload NDJSON bytes to the presigned R2 PUT URL returned by
   * `createDatasetVersion`. Presigned URLs carry their own auth — no
   * Bearer header, and the body is sent as-is (buffered, because S3-style
   * presigned PUTs reject chunked transfer encoding).
   */
  async uploadNdjson(uploadUrl: string, body: Buffer | string): Promise<void> {
    let res: Response
    try {
      res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/x-ndjson' },
        body,
      })
    } catch (err) {
      throw describeNetworkFailure(new URL(uploadUrl).origin, err)
    }
    if (!res.ok) {
      throw new Error(`Upload failed: HTTP ${res.status}`)
    }
  }
}
