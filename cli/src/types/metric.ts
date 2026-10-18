/**
 * Metric (tracking definition) shapes for the `/api/cli/projects/{shortId}/metrics`
 * routes behind `avsb metrics`.
 */

export type CliMetricType = 'CLICK' | 'PAGEVIEW' | 'CUSTOM'

export type CliUrlMatchMode =
  | 'SIMPLE'
  | 'EXACT'
  | 'PATH'
  | 'SUBSTRING'
  | 'PATTERN'
  | 'REGEX'

// CLI-side discriminated union for `createMetric`. The server resolves the
// owning project from the URL `[shortId]` param, so `projectId` is omitted
// from the wire body the CLI sends.
export type CreateMetricBody =
  | {
      type: 'CLICK'
      name: string
      description?: string | null
      cssSelector: string
      pageUrl?: string | null
    }
  | {
      type: 'PAGEVIEW'
      name: string
      description?: string | null
      urlMatch: string
      urlMatchMode: CliUrlMatchMode
    }
  | {
      type: 'CUSTOM'
      name: string
      description?: string | null
      eventKey: string
      hasValueField: boolean
    }

export type UpdateMetricBody = Partial<{
  name: string
  description: string | null
  cssSelector: string
  pageUrl: string | null
  urlMatch: string
  urlMatchMode: CliUrlMatchMode
  eventKey: string
  hasValueField: boolean
}>

export interface CliMetric {
  id: string
  shortId: number
  projectId: string
  name: string
  description: string | null
  type: CliMetricType
  cssSelector: string | null
  urlMatch: string | null
  urlMatchMode: CliUrlMatchMode | null
  pageUrl: string | null
  eventKey: string | null
  hasValueField: boolean
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CliMetricUsage {
  experimentCount: number
  flagRuleCount: number
}

/** What an archive detached, sent beside the metric by the archive route. */
export interface CliMetricArchiveCascade {
  experimentCount: number
  flagRuleCount: number
  bindingCount: number
}

export interface ApiMetricResponse {
  data: { metric: CliMetric; cascade?: CliMetricArchiveCascade }
}

export interface ApiMetricListResponse {
  data: {
    metrics: CliMetric[]
    usage: Record<string, CliMetricUsage>
  }
}

export interface ApiMetricDeleteResponse {
  data: { id: string }
}
