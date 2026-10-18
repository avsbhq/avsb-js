/**
 * Local development shapes: compiled experiment output plus the WebSocket
 * frames `avsb dev` exchanges with the browser extension.
 */

export interface CompiledVariation {
  variationId: string
  name: string
  type: 'CONTROL' | 'VARIANT'
  js: string
  css: string
}

export interface CompiledExperiment {
  experimentId: string
  triggersJs: string
  variations: CompiledVariation[]
  compiledAt: number
}

export type WsMessageFromCli =
  | {
      type: 'dev:init'
      experimentId: string
      experimentName: string
      snippetKey: string
      triggersJs: string
      variations: CompiledVariation[]
      compiledAt: number
      allowedVariations: number[]
    }
  | {
      type: 'dev:update'
      experimentId: string
      changeType: 'css-only' | 'js-only' | 'both' | 'trigger'
      triggersJs: string
      variations: CompiledVariation[]
      compiledAt: number
      allowedVariations: number[]
    }
  | {
      type: 'dev:error'
      file: string
      errors: Array<{ line: number; column: number; message: string }>
    }
  | {
      type: 'project:init'
      projectId: string
      snippetKey: string
      projectJs: string
      compiledAt: number
    }
  | {
      type: 'project:update'
      projectId: string
      projectJs: string
      compiledAt: number
    }
  | {
      type: 'dev:disconnect'
      reason: 'cli-stopped' | 'user-quit'
    }
  | {
      type: 'ping'
      timestamp: number
    }

export type WsMessageFromExtension =
  | {
      type: 'ext:connect'
      tabId: number
      pageUrl: string
      snippetDetected: boolean
      snippetKey: string | null
    }
  | {
      type: 'ext:switch-variation'
      variationId: string
    }
  | {
      type: 'pong'
      timestamp: number
    }
