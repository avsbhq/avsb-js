/**
 * Metric-binding (analysis-side wrapper) shapes for the
 * `/api/cli/projects/{shortId}/metric-bindings` routes behind
 * `avsb metric-bindings`.
 */

import type { CliMetricType, CliUrlMatchMode } from './metric.js'

export type CliMeasure =
  | 'UNIQUE_CONVERSIONS_PER_VISITOR'
  | 'TOTAL_EVENTS'
  | 'UNIQUE_VISITORS_WHO_FIRED'
  | 'TOTAL_VALUE_PER_VISITOR'
  | 'TOTAL_VALUE'
  | 'PERCENTILE'
  | 'RATE'
  | 'COMPOSITE'

export type CliMetricBindingDirection = 'INCREASE' | 'DECREASE'

export interface CliCompositionEntry {
  metricId: string
  weight: number
}

export interface CliWinsorization {
  enabled: boolean
  upperPercentile: number
  lowerPercentile: number
}

/**
 * Wire body for `createMetricBinding`. The server resolves the owning
 * project from the URL `[shortId]`, so the body carries no `projectId`.
 */
export interface CreateMetricBindingBody {
  name: string
  description?: string | null
  measure: CliMeasure
  direction: CliMetricBindingDirection
  isLibrary: boolean
  metricId?: string
  numeratorMetricId?: string
  denominatorMetricId?: string
  valueSource?: string
  percentile?: number
  composition?: CliCompositionEntry[]
  winsorization?: CliWinsorization | null
}

export type UpdateMetricBindingBody = Partial<{
  name: string
  description: string | null
  measure: CliMeasure
  direction: CliMetricBindingDirection
  isLibrary: boolean
  metricId: string | null
  numeratorMetricId: string | null
  denominatorMetricId: string | null
  valueSource: string | null
  percentile: number | null
  composition: CliCompositionEntry[] | null
  winsorization: CliWinsorization | null
}>

export interface CliMetricBindingMetricRef {
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
}

export interface CliMetricBinding {
  id: string
  shortId: number
  orgId: string
  projectId: string
  name: string
  description: string | null
  measure: CliMeasure
  direction: CliMetricBindingDirection
  isLibrary: boolean
  metricId: string | null
  numeratorMetricId: string | null
  denominatorMetricId: string | null
  percentile: number | null
  valueSource: string | null
  winsorization: CliWinsorization | null
  composition: CliCompositionEntry[] | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  createdByUserId: string | null
  metric: CliMetricBindingMetricRef | null
  numeratorMetric: CliMetricBindingMetricRef | null
  denominatorMetric: CliMetricBindingMetricRef | null
}

export interface ApiMetricBindingResponse {
  data: {
    metricBinding: CliMetricBinding
  }
}

export interface ApiMetricBindingListResponse {
  data: {
    metricBindings: CliMetricBinding[]
  }
}

export interface ApiMetricBindingDeleteResponse {
  data: { id: string }
}
