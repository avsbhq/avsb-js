/**
 * Dataset shapes (server-side datasets, e-commerce suite Phase 2) for the
 * `/api/cli/projects/{shortId}/datasets` routes behind `avsb datasets`.
 */

export type CliDatasetType = 'LIST' | 'TABLE' | 'FEED'

export type CliDatasetVersionStatus =
  | 'UPLOADING'
  | 'COMMITTING'
  | 'COMMITTED'
  | 'ACTIVE'
  | 'ARCHIVED'
  | 'FAILED'

/** Per-row failure recorded by the ingest consumer when a commit fails. */
export interface CliDatasetVersionError {
  line?: number
  reason?: string
}

export interface CliDatasetVersion {
  id: string
  shortId: number
  datasetId: string
  label: string | null
  status: CliDatasetVersionStatus
  rowCount: number
  error: CliDatasetVersionError | null
  createdAt: string
  committedAt: string | null
}

export interface CliDataset {
  id: string
  shortId: number
  projectId: string
  slug: string
  name: string
  type: CliDatasetType
  source: 'USER' | 'SYSTEM'
  keyField: string
  liveVersionId: string | null
  /** shortId of the live version (flattened by the server's serializer), or null. */
  liveVersionShortId: number | null
  createdAt: string
  updatedAt: string
}

export interface ApiDatasetListResponse {
  data: { datasets: CliDataset[] }
}

export interface ApiDatasetDetailResponse {
  data: { dataset: CliDataset; versions: CliDatasetVersion[] }
}

export interface ApiDatasetVersionCreateResponse {
  data: { version: CliDatasetVersion; uploadUrl: string }
}

export interface ApiDatasetVersionResponse {
  data: { version: CliDatasetVersion }
}

export interface ApiDatasetActivateResponse {
  data: { dataset: CliDataset; version: CliDatasetVersion }
}
