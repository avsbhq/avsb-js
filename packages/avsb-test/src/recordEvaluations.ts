import type { MockClient } from './createMockClient';
import type { EvaluationRecord } from './mockEvaluator';

// ONE definition, shared with `MockClient._evaluations()`: the recorder and
// the mock hand back the same rows, so a second identical interface here was
// one interface too many.
export type { EvaluationRecord };

export interface RecorderMatcher {
  withContext(ctx: { kind: string; key: string }): RecorderMatcher;
  withValue(value: unknown): RecorderMatcher;
}

export interface TrackMatcher {
  withValue(value: number): TrackMatcher;
  withProperties(props: Record<string, unknown>): TrackMatcher;
}

export interface Recorder {
  records: EvaluationRecord[];
  /** Assert that a flag was evaluated. Returns a chainable matcher. */
  toHaveEvaluated(flagKey: string): RecorderMatcher;
  /** Assert that a track event was sent. */
  toHaveTracked(eventKey: string): TrackMatcher;
  /** Stop listening and clear records. */
  stop(): void;
}

function createRecorderMatcher(records: EvaluationRecord[], flagKey: string): RecorderMatcher {
  // Find the matching evaluation records at assertion time (lazy)
  const self: RecorderMatcher = {
    withContext(ctx: { kind: string; key: string }): RecorderMatcher {
      const matching = records.filter((r) => r.flagKey === flagKey && r.contextKey === ctx.key);
      if (matching.length === 0) {
        throw new Error(
          `recordEvaluations: expected flag "${flagKey}" to be evaluated with context ` +
            `{ kind: "${ctx.kind}", key: "${ctx.key}" } but no such evaluation was recorded. ` +
            `Recorded evaluations: ${JSON.stringify(records.filter((r) => r.flagKey === flagKey))}`,
        );
      }
      return self;
    },

    withValue(value: unknown): RecorderMatcher {
      const matching = records.filter(
        (r) => r.flagKey === flagKey && JSON.stringify(r.value) === JSON.stringify(value),
      );
      if (matching.length === 0) {
        const actual = records.filter((r) => r.flagKey === flagKey).map((r) => r.value);
        throw new Error(
          `recordEvaluations: expected flag "${flagKey}" to be evaluated with value ` +
            `${JSON.stringify(value)} but recorded values were: ${JSON.stringify(actual)}`,
        );
      }
      return self;
    },
  };
  return self;
}

function createTrackMatcher(client: MockClient, eventKey: string): TrackMatcher {
  const self: TrackMatcher = {
    withValue(value: number): TrackMatcher {
      const matching = client
        ._tracked()
        .filter(
          (t) => t.eventKey === eventKey && t.payload !== undefined && t.payload.value === value,
        );
      if (matching.length === 0) {
        const actual = client
          ._tracked()
          .filter((t) => t.eventKey === eventKey)
          .map((t) => t.payload?.value);
        throw new Error(
          `recordEvaluations: expected track event "${eventKey}" with value ${value} ` +
            `but recorded values were: ${JSON.stringify(actual)}`,
        );
      }
      return self;
    },

    withProperties(props: Record<string, unknown>): TrackMatcher {
      const propsJson = JSON.stringify(props);
      const matching = client
        ._tracked()
        .filter(
          (t) =>
            t.eventKey === eventKey &&
            t.payload?.properties !== undefined &&
            JSON.stringify(t.payload.properties) === propsJson,
        );
      if (matching.length === 0) {
        const actual = client
          ._tracked()
          .filter((t) => t.eventKey === eventKey)
          .map((t) => t.payload?.properties);
        throw new Error(
          `recordEvaluations: expected track event "${eventKey}" with properties ` +
            `${propsJson} but recorded properties were: ${JSON.stringify(actual)}`,
        );
      }
      return self;
    },
  };
  return self;
}

/**
 * Attach to a MockClient's evaluation and track event streams.
 * Returns a Recorder with fluent assertion helpers.
 *
 * Usage:
 *   const recorder = recordEvaluations(client)
 *   // ... run code under test ...
 *   recorder.toHaveEvaluated('my-flag').withValue(true)
 *   recorder.toHaveTracked('purchase').withValue(49.99)
 *   recorder.stop()
 */
export function recordEvaluations(client: MockClient): Recorder {
  const records: EvaluationRecord[] = [];

  const unsubscribeEvaluation = client.on('evaluation', (data) => {
    records.push({
      flagKey: data.flagKey,
      value: data.flag.value,
      contextKey: data.contextKeys[0] ?? '',
    });
  });

  const recorder: Recorder = {
    get records(): EvaluationRecord[] {
      return records;
    },

    toHaveEvaluated(flagKey: string): RecorderMatcher {
      const matching = records.filter((r) => r.flagKey === flagKey);
      if (matching.length === 0) {
        throw new Error(
          `recordEvaluations: expected flag "${flagKey}" to be evaluated, ` +
            `but it was not. Evaluated flags: ${JSON.stringify([...new Set(records.map((r) => r.flagKey))])}`,
        );
      }
      return createRecorderMatcher(records, flagKey);
    },

    toHaveTracked(eventKey: string): TrackMatcher {
      const tracked = client._tracked();
      const matching = tracked.filter((t) => t.eventKey === eventKey);
      if (matching.length === 0) {
        throw new Error(
          `recordEvaluations: expected track event "${eventKey}" to be sent, ` +
            `but it was not. Tracked events: ${JSON.stringify([...new Set(tracked.map((t) => t.eventKey))])}`,
        );
      }
      return createTrackMatcher(client, eventKey);
    },

    stop(): void {
      unsubscribeEvaluation();
      records.length = 0;
    },
  };

  return recorder;
}
