/**
 * Project shapes: the local `.avsb-project.json` manifest `avsb project pull`
 * writes, and the `/api/cli/projects/{shortId}` response behind it.
 */

export interface ProjectManifest {
  version: 1
  projectId: string
  projectShortId: number
  projectName: string
  orgId: string
  snippetKey: string
  language: 'js' | 'ts'
  lastSyncedAt: string
  platformUrl: string
  syncedHash?: string
}

export interface ApiProjectResponse {
  data: {
    project: {
      id: string
      shortId: number
      name: string
      editorProjectJs: string | null
      editorProjectTs: string | null
      projectJsLang: 'JAVASCRIPT' | 'TYPESCRIPT'
      snippetKey: string
      org: {
        id: string
        name: string
      }
    }
  }
}
