/**
 * Feature-flag shapes for `avsb flags`.
 *
 * Unlike every other CLI command group, flags talk to the PUBLIC API
 * (`/api/v1/projects/{projectId}/flags/**`) rather than `/api/cli`, because
 * that is where the flag lifecycle lives. A personal access token
 * (`avsb_pat_…`) authenticates there and gets the scopes of your role in the
 * organization, so no second credential is needed.
 *
 * THREE WIRE SHAPES, one rendered shape. The routes do not agree with each
 * other, and the CLI must not pretend they do:
 *
 *   - LIST flattens each environment (`environmentKey`, `environmentName`) in
 *     `flagListService`'s projection.
 *   - GET and CREATE return the stored rows with the relation nested
 *     (`environment: { id, name, key }`) and no flattened copies.
 *   - PATCH returns the bare flag row: no `variations`, no `envConfigs` at all.
 *
 * `WireFlag` models what may arrive, `CliFlag` models what the CLI prints, and
 * `normalizeFlag` (flags.helpers.ts) is the one place that bridges them.
 * `--json` emits the wire body untouched, so the CLI never reshapes or invents
 * what the platform said.
 */

import type { CliListPage } from './pagination.js'

export type CliFlagType = 'BOOLEAN' | 'STRING' | 'NUMBER' | 'JSON'

export type CliFlagStatus = 'DRAFT' | 'RUNNING' | 'PAUSED' | 'ARCHIVED'

export interface CliFlagVariation {
  id: string
  flagId: string
  name: string
  key: string
  value: string
  sortOrder: number
}

/** Per-environment config after normalization: what the CLI prints. */
export interface CliFlagEnvConfig {
  environmentId: string
  environmentName: string
  environmentKey: string
  enabled: boolean
  hasPendingChanges: boolean
}

/** Per-environment config as it may arrive: flattened (list) or nested (get, create). */
export interface WireFlagEnvConfig {
  environmentId?: string
  environmentName?: string
  environmentKey?: string
  enabled?: boolean
  hasPendingChanges?: boolean
  environment?: { id?: string; name?: string; key?: string }
}

/** A flag as it may arrive from any of the three routes. */
export interface WireFlag {
  id: string
  shortId: number
  name: string
  key: string
  type: CliFlagType
  status: CliFlagStatus
  stale?: boolean
  description?: string | null
  createdAt?: string
  updatedAt?: string
  /** Absent on the PATCH response. */
  variations?: CliFlagVariation[]
  /** Absent on the PATCH response. */
  envConfigs?: WireFlagEnvConfig[]
}

/** A flag after normalization: every field the CLI renders is present. */
export interface CliFlag {
  id: string
  shortId: number
  name: string
  key: string
  type: CliFlagType
  status: CliFlagStatus
  stale: boolean
  description: string | null
  variations: CliFlagVariation[]
  envConfigs: CliFlagEnvConfig[]
  /** False when the response carried no environment block at all (PATCH). */
  hasEnvironmentData: boolean
}

export interface ApiFlagListResponse {
  data: WireFlag[]
  page: CliListPage
}

export interface ApiFlagResponse {
  data: WireFlag
}

/** Result of `POST …/flags/{flagId}/envs/{envId}/run` and its `pause` twin. */
export interface CliFlagEnvTransition {
  status: CliFlagStatus
  previousStatus: CliFlagStatus
  changed: boolean
  affectedRules: Array<{ id: string; name: string | null; status: string }>
}

export interface ApiFlagEnvTransitionResponse {
  data: CliFlagEnvTransition
}

/** Wire body for `POST /api/v1/projects/{projectId}/flags`. */
export interface CreateFlagBody {
  name: string
  key: string
  description?: string
  type: CliFlagType
  variations: Array<{ name: string; key: string; value: string }>
  defaultVariationKey: string
}

/** Wire body for `PATCH …/flags/{flagId}`. `description: null` clears it. */
export interface UpdateFlagBody {
  name?: string
  description?: string | null
  key?: string
}
