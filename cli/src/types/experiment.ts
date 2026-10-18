/**
 * Experiment shapes: the local `.avsb.json` manifest a clone writes, the
 * `/api/cli/experiments/{shortId}` response it is built from, and the leaner
 * public-API experiment row `avsb experiments list` prints.
 */

export type ExperimentStatus = 'DRAFT' | 'SCHEDULED' | 'RUNNING' | 'PAUSED' | 'COMPLETED'

export interface TargetingRule {
  url: string
  matchType: 'SIMPLE' | 'EXACT' | 'SUBSTRING' | 'REGEX'
  condition: 'MATCHES' | 'DOES_NOT_MATCH'
}

export interface ManifestVariation {
  id: string
  shortId: number
  name: string
  type: 'CONTROL' | 'VARIANT'
  weight: number
  folder: string
  scriptFile: string
  styleFile: string
}

export interface SyncedHashes {
  triggersJs: string
  variations: Record<string, { controlJs: string; controlCss: string }>
}

export interface AvsbManifest {
  version: number
  experimentId: string
  experimentShortId: number
  experimentName: string
  projectId: string
  projectShortId: number
  orgId: string
  snippetKey: string
  status: ExperimentStatus
  languages: {
    script: 'js' | 'ts'
    style: 'css' | 'scss'
  }
  trafficAlloc: number
  targetingRules: TargetingRule[]
  variations: ManifestVariation[]
  allowedVariations: number[]
  lastSyncedAt: string
  platformUrl: string
  syncedHashes?: SyncedHashes
}

export interface ApiVariation {
  id: string
  shortId: number
  name: string
  type: 'CONTROL' | 'VARIANT'
  weight: number
  controlJs: string
  controlCss: string
}

export interface ApiExperimentResponse {
  data: {
    experiment: {
      id: string
      shortId: number
      name: string
      description: string | null
      status: ExperimentStatus
      triggersJs: string
      scriptLang: 'JAVASCRIPT' | 'TYPESCRIPT'
      styleLang: 'CSS' | 'SCSS'
      trafficAlloc: number
      targetingRules: TargetingRule[]
      hasPendingChanges: boolean
      variations: ApiVariation[]
      metrics: Array<{
        id: string
        name: string
        type: string
        config: Record<string, unknown>
        isPrimary: boolean
      }>
      audiences: Array<{
        id: string
        name: string
        rules: unknown
      }>
    }
    project: {
      id: string
      shortId: number
      name: string
      snippetKey: string
    }
    org: {
      id: string
      name: string
    }
  }
}

/**
 * One row of `GET /api/v1/projects/{projectId}/experiments`, which `avsb
 * experiments list` prints. Only the fields the CLI reads are declared; the
 * public list row carries more (schedule, traffic, audiences) and those pass
 * through untouched into `--json` output.
 */
export interface CliPublicExperiment {
  id: string
  shortId: number
  name: string
  status: ExperimentStatus
  createdAt: string
  updatedAt: string
  [key: string]: unknown
}
