/**
 * The calls `avsb init` makes, on top of the existing clients.
 *
 * Projects and environments come from the PUBLIC API (`/api/v1`), which is
 * where both resources live and which accepts the same personal access token
 * the rest of the CLI uses. The datafile comes from `/api/cli`, which is the
 * only route that serves the built file for a project and environment key.
 *
 * A subclass rather than new methods on `ApiClient` because that file is at its
 * size limit, and because these four calls exist for one command.
 */

import { FlagsApiClient } from './flagsApi.js'
import type {
  CliEnvironmentListResponse,
  CliInitDatafile,
  CliProjectListResponse,
  CliProjectResponse,
  CliProjectType,
} from '../types/init.js'

export interface CreateProjectInput {
  name: string
  type: CliProjectType
  /** Required by the platform for web experimentation projects. */
  url?: string
}

export class InitApiClient extends FlagsApiClient {
  /** One page of the organization's projects, newest cursor rules apply. */
  async listProjects(
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<CliProjectListResponse> {
    const params = new URLSearchParams()
    if (opts.limit != null) params.set('limit', String(opts.limit))
    if (opts.cursor) params.set('cursor', opts.cursor)
    const qs = params.toString()
    return this.request<CliProjectListResponse>(`/api/v1/projects${qs ? `?${qs}` : ''}`)
  }

  /**
   * One project. The path accepts a numeric short id or the row's cuid, so the
   * short id a developer reads off the dashboard works directly.
   */
  async getProjectByRef(projectRef: string | number): Promise<CliProjectResponse> {
    return this.request<CliProjectResponse>(
      `/api/v1/projects/${encodeURIComponent(String(projectRef))}`,
    )
  }

  /**
   * Create a project. A feature-flag project comes back with its production and
   * development environments already seeded, each with an SDK key, which is why
   * init can write a key immediately after creating one.
   */
  async createProject(body: CreateProjectInput): Promise<CliProjectResponse> {
    return this.request<CliProjectResponse>('/api/v1/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  async listEnvironments(
    projectRef: string | number,
    opts: { limit?: number } = {},
  ): Promise<CliEnvironmentListResponse> {
    const limit = opts.limit ?? 100
    return this.request<CliEnvironmentListResponse>(
      `/api/v1/projects/${encodeURIComponent(String(projectRef))}/environments?limit=${limit}`,
    )
  }

  /**
   * The built datafile for one environment, exactly as an SDK holding that key
   * receives it. Used to name a real flag in the example file and to report what
   * the environment serves, rather than printing a claim nothing checked.
   *
   * No `{ data }` envelope: this `/api/cli` route answers with the datafile body
   * at the top level.
   */
  async getInitDatafile(projectShortId: number, environmentKey: string): Promise<CliInitDatafile> {
    return this.request<CliInitDatafile>(
      `/api/cli/projects/${projectShortId}/datafile?env=${encodeURIComponent(environmentKey)}`,
    )
  }
}
