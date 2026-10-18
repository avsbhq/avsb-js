/**
 * Shapes `avsb init` reads from the platform.
 *
 * Three of them are subsets of frozen public-API contracts
 * (`app/_lib/contracts/projects.ts`, `app/_lib/contracts/environments.ts`) with
 * only the fields init actually uses, so an added field on the wire cannot
 * break the command. The fourth is the flag datafile, which `/api/cli` returns
 * at the top level with no envelope.
 */

import type { CliListPage } from './pagination.js'

export type CliProjectType = 'WEB_EXPERIMENTATION' | 'FEATURE_FLAG'

/** A project as `/api/v1/projects` lists it. */
export interface CliPublicProject {
  id: string
  shortId: number
  name: string
  type: CliProjectType
  /** Web experiments only. Public identifier in the install tag. */
  snippetKey: string | null
}

export interface CliProjectListResponse {
  data: CliPublicProject[]
  page: CliListPage
}

export interface CliProjectResponse {
  data: CliPublicProject
}

/**
 * A flag environment as `/api/v1/projects/{projectId}/environments` lists it.
 *
 * `lastSdkSeenAt` is the heartbeat stamp: every SDK posts to
 * `/api/sdk/heartbeat` after a successful datafile fetch, and that write is what
 * `avsb init` waits for as proof the install works.
 */
export interface CliFlagEnvironment {
  id: string
  key: string
  name: string
  sdkKey: string
  lastSdkSeenAt: string | null
  lastSdkType: string | null
  lastSdkVersion: string | null
}

export interface CliEnvironmentListResponse {
  data: CliFlagEnvironment[]
  page: CliListPage
}

/** One flag in the datafile, narrowed to what init reads. */
export interface CliDatafileFlag {
  key: string
  type: 'boolean' | 'string' | 'number' | 'json'
  /** False when the environment is not serving this flag's rules. */
  enabled: boolean
  defaultVariationId: string
  variations: Array<{ id: string; key: string; value: unknown }>
}

export interface CliInitDatafile {
  flags: CliDatafileFlag[]
  publishedAt?: string
}
