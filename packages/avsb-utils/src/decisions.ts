// Decision recorder + redaction + sampling. Spec §6.6.
//
// Decision logging records every flag evaluation alongside the rule that
// served it. The recorder samples + redacts before forwarding to one or
// more sinks (OTel, Sentry, Datadog, or any of the warehouse sinks).

import type { DecisionLogEntry } from '@avsbhq/core'

export interface DecisionSink {
  name: string
  write(batch: DecisionLogEntry[]): Promise<void>
}

export interface DecisionRecorderOptions {
  /** Sampling rate 0..1. Default 1 (record every decision). */
  sample?: number
  /** Attribute keys to redact in value + reasons before forwarding. */
  privateAttributes?: string[]
  /** Sinks called per recorded decision. Each fire-and-forget. */
  sinks: DecisionSink[]
  /** Max buffered before forced flush. Default 1000. */
  bufferSize?: number
  /** Flush interval ms. Default 5000. */
  flushInterval?: number
  /** Logger for sink errors. */
  onSinkError?: (sinkName: string, err: Error) => void
}

export interface DecisionRecorder {
  record(entry: DecisionLogEntry): void
  /** Flush the buffer immediately. */
  flush(): Promise<void>
  /** Drain timers + flush once more. */
  close(): Promise<void>
  /** Buffer size, useful in tests. */
  bufferedCount(): number
}

const REDACT = '[REDACTED]'

function redactEntry(
  entry: DecisionLogEntry,
  privateKeys: Set<string>
): DecisionLogEntry {
  if (privateKeys.size === 0) return entry
  const reasons = entry.reasons.map((r) => redactString(r, privateKeys))
  return {
    ...entry,
    reasons,
    // Value redaction is conservative: when the value is an object, any key
    // matching a private key is replaced. Scalars pass through unchanged.
    value: redactValue(entry.value, privateKeys),
  }
}

function redactString(str: string, privateKeys: Set<string>): string {
  let out = str
  for (const k of privateKeys) {
    const pattern = new RegExp(`(\\b${escapeRegex(k)}\\s*[:=]\\s*)\\S+`, 'g')
    out = out.replace(pattern, `$1${REDACT}`)
  }
  return out
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function redactValue(value: unknown, privateKeys: Set<string>): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redactValue(v, privateKeys))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = privateKeys.has(k) ? REDACT : redactValue(v, privateKeys)
  }
  return out
}

export function createDecisionRecorder(
  opts: DecisionRecorderOptions
): DecisionRecorder {
  const sample = opts.sample ?? 1
  const privateKeys = new Set(opts.privateAttributes ?? [])
  const bufferSize = opts.bufferSize ?? 1000
  const flushInterval = opts.flushInterval ?? 5000
  const sinks = opts.sinks
  const onSinkError = opts.onSinkError ?? (() => undefined)

  let buffer: DecisionLogEntry[] = []
  let closed = false
  let timer: ReturnType<typeof setInterval> | null = null

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return
    const batch = buffer
    buffer = []
    await Promise.all(
      sinks.map((s) =>
        s.write(batch).catch((err) => {
          onSinkError(s.name, err instanceof Error ? err : new Error(String(err)))
        })
      )
    )
  }

  const scheduleTimer = (): void => {
    if (timer || flushInterval <= 0) return
    timer = setInterval(() => {
      void flush()
    }, flushInterval)
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      ;(timer as { unref: () => void }).unref()
    }
  }

  return {
    record(entry) {
      if (closed) return
      if (sample < 1 && Math.random() > sample) return
      buffer.push(redactEntry(entry, privateKeys))
      scheduleTimer()
      if (buffer.length >= bufferSize) {
        void flush()
      }
    },
    flush,
    async close() {
      closed = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      await flush()
    },
    bufferedCount() {
      return buffer.length
    },
  }
}
