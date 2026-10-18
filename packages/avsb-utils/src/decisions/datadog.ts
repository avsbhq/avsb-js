// Datadog decision sink. POSTs each batch to the Datadog logs intake.

import type { DecisionLogEntry } from '@avsbhq/core'
import type { DecisionSink } from '../decisions'

export interface DatadogSinkOptions {
  apiKey: string
  /** datadoghq.com (default), datadoghq.eu, etc. */
  site?: string
  /** Default 'sdk:avsb,kind:decision'. */
  ddtags?: string
  /** Default 'avsb-sdk'. */
  service?: string
  /** Override fetch (testability). */
  fetchImpl?: typeof fetch
}

export function createDatadogSink(opts: DatadogSinkOptions): DecisionSink {
  const site = opts.site ?? 'datadoghq.com'
  const ddtags = opts.ddtags ?? 'sdk:avsb,kind:decision'
  const service = opts.service ?? 'avsb-sdk'
  const f = opts.fetchImpl ?? fetch
  const url = `https://http-intake.logs.${site}/api/v2/logs`
  return {
    name: 'datadog',
    async write(batch) {
      const payload = batch.map((e) => ({
        ddsource: 'avsb',
        ddtags,
        service,
        hostname: 'avsb-sdk',
        message: `flag ${e.flagKey} → ${e.variationKey ?? 'default'}`,
        attributes: {
          flagKey: e.flagKey,
          variationKey: e.variationKey,
          source: e.source,
          ruleId: e.ruleId,
          ruleType: e.ruleType,
          reasons: e.reasons,
          durationMicros: e.durationMicros,
          contextSummary: e.contextSummary,
        },
      }))
      const res = await f(url, {
        method: 'POST',
        headers: {
          'DD-API-KEY': opts.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        throw new Error(`Datadog ingest failed: ${res.status}`)
      }
    },
  }
}
