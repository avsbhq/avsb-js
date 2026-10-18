// Internal shared decision-log factory used by every framework middleware.
// Kept private — the public `createDecisionLog` lives in `@avsbhq/node`.

import type { DecisionLog, DecisionLogEntry } from '@avsbhq/core'

export function createDecisionLog(): DecisionLog & {
  push(entry: DecisionLogEntry): void
} {
  const entries: DecisionLogEntry[] = []
  return {
    get entries() {
      return entries
    },
    push(entry) {
      entries.push(entry)
    },
  }
}
