// The cross-language conformance corpus, replayed through `AvsbServer`
// (spec section 7, Lane B1 gate: "the conformance runner for node").
//
// packages/avsb-conformance replays its fixtures through the bare engine.
// This file replays the same fixtures through the CLIENT a customer
// installs: bootstrap, `forUser(ctx).getFlag`, source mapping and all. A
// client layer that rewrote a decision (a sticky path, an override store,
// a source mapping) would pass the engine suite and fail here.
//
// Both families run: the single-context corpus (fixtures/manifest.json)
// and the 200-context allocation family (fixtures/allocation/). Fail-hard
// like every harness: an empty manifest or a missing file throws, and the
// counts that ran are asserted. The network is stubbed, and the datafile
// endpoints are rewritten to `.invalid`, so nothing leaves the machine.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { EvalContext, FlagDatafile } from '@avsbhq/core'
import { AvsbServer } from './AvsbServer'

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'avsb-conformance',
  'fixtures'
)

interface Expected {
  value: unknown
  variationKey: string | null
  source: string
  ruleId: string | null
  ruleType: string | null
  reasons: string[]
}

interface Evaluation {
  label: string
  context: EvalContext
  expected: Expected
}

interface Scenario {
  name: string
  datafile: FlagDatafile
  flagKey: string
  defaultValue: unknown
  evaluations: Evaluation[]
}

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, relative), 'utf8')) as T
}

/** Point every data-plane endpoint at a host that cannot resolve. */
function offline(datafile: FlagDatafile): FlagDatafile {
  return {
    ...datafile,
    collectEndpoint: 'https://collect.conformance.invalid',
    heartbeatEndpoint: 'https://heartbeat.conformance.invalid/api/sdk/heartbeat',
    streamEndpoint: undefined,
  }
}

function loadScenarios(): { corpus: Scenario[]; allocation: Scenario[] } {
  const manifest = readJson<{ cases: Array<{ case: string; expected: string }> }>('manifest.json')
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new Error(`conformance manifest at ${FIXTURES} lists no cases`)
  }
  const corpus = manifest.cases.map((entry) => {
    const fixture = readJson<{
      datafile: string
      context: string
      flagKey: string
      defaultValue: unknown
      expected: Expected
    }>(entry.expected)
    return {
      name: entry.case,
      datafile: offline(readJson<FlagDatafile>(fixture.datafile)),
      flagKey: fixture.flagKey,
      defaultValue: fixture.defaultValue,
      evaluations: [
        { label: entry.case, context: readJson<EvalContext>(fixture.context), expected: fixture.expected },
      ],
    }
  })

  const allocationManifest = readJson<{
    contextsPerFixture: number
    fixtures: Array<{ case: string; file: string }>
  }>('allocation/manifest.json')
  if (!Array.isArray(allocationManifest.fixtures) || allocationManifest.fixtures.length === 0) {
    throw new Error(`allocation manifest at ${FIXTURES}/allocation lists no fixtures`)
  }
  const allocation = allocationManifest.fixtures.map((entry) => {
    const fixture = readJson<{
      datafile: FlagDatafile
      flagKey: string
      defaultValue: unknown
      evaluations: Array<{ context: EvalContext; expected: Expected }>
    }>(join('allocation', entry.file))
    if (fixture.evaluations.length !== allocationManifest.contextsPerFixture) {
      throw new Error(`${entry.file} carries ${fixture.evaluations.length} evaluations`)
    }
    return {
      name: entry.case,
      datafile: offline(fixture.datafile),
      flagKey: fixture.flagKey,
      defaultValue: fixture.defaultValue,
      evaluations: fixture.evaluations.map((e) => ({
        label: `${entry.case} ${String((e.context as { key?: unknown }).key)}`,
        context: e.context,
        expected: e.expected,
      })),
    }
  })
  return { corpus, allocation }
}

/** Every evaluation in the scenario, through one bootstrapped server. */
async function replay(scenario: Scenario): Promise<string[]> {
  const server = new AvsbServer({
    sdkKey: 'sdk_production_conformancefixture01',
    bootstrap: scenario.datafile,
    streaming: false,
    logLevel: 'silent',
  })
  const drift: string[] = []
  for (const { label, context, expected } of scenario.evaluations) {
    const flag = server.forUser(context).getFlag(scenario.flagKey, scenario.defaultValue, {
      decideOptions: ['DISABLE_EXPOSURE'],
    })
    const observed = {
      value: flag.value,
      variationKey: flag.variationKey,
      source: flag.source,
      ruleId: flag.ruleId,
      ruleType: flag.ruleType,
      reasons: flag.reasons,
    }
    if (JSON.stringify(observed) !== JSON.stringify(expected)) {
      drift.push(`${label}: got ${JSON.stringify(observed)}`)
    }
  }
  await server.close()
  return drift
}

const { corpus, allocation } = loadScenarios()
const fetchSpy = vi.fn(async () => {
  throw new Error('conformance runs offline: no request may leave the machine')
})

beforeAll(() => {
  vi.stubGlobal('fetch', fetchSpy)
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('conformance corpus through @avsbhq/node AvsbServer', () => {
  it('reproduces every single-context case', async () => {
    const drift = (await Promise.all(corpus.map(replay))).flat()
    expect(corpus.length).toBeGreaterThanOrEqual(81)
    expect(drift).toEqual([])
  })

  it('reproduces all 1,200 targeted delivery allocation evaluations', async () => {
    const drift = (await Promise.all(allocation.map(replay))).flat()
    const ran = allocation.reduce((sum, s) => sum + s.evaluations.length, 0)
    expect(allocation).toHaveLength(6)
    expect(ran).toBe(1200)
    expect(drift).toEqual([])
  })

  it('sent nothing over the network while replaying', () => {
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
