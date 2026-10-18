import { describe, expect, it } from 'vitest'
import { CliError } from '../lib/cliError.js'
import {
  buildCreateFlagBody,
  describeEnvState,
  describeTransition,
  formatFlagTable,
  normalizeEnvConfig,
  normalizeFlag,
  selectEnvConfig,
} from './flags.helpers.js'
import type { CliFlag, WireFlag } from '../types/flag.js'

// ---------------------------------------------------------------------------
// Fixtures are the REAL wire bodies, not a convenient middle ground. The three
// flag routes disagree with each other, and a fixture that smoothed that over
// is exactly why `avsb flags toggle` shipped broken:
//
//   LIST   flattens environmentKey / environmentName (flagListService's select)
//   GET    returns the stored row with `environment` nested, no flattened names
//   PATCH  returns the bare flag row: no variations, no envConfigs at all
// ---------------------------------------------------------------------------

/** One env config exactly as `GET …/flags/{flagId}` returns it. */
function nestedEnvConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cfg_1',
    flagId: 'flag_1',
    environmentId: 'env_prod',
    enabled: true,
    status: 'RUNNING',
    statusChangedAt: null,
    defaultVariationId: 'var_off',
    hasPendingChanges: false,
    lastPublishedAt: null,
    launchedAt: '2026-02-01T00:00:00.000Z',
    publishedSnapshot: null,
    schedulingEnabled: false,
    environment: { id: 'env_prod', name: 'Production', key: 'production' },
    ...overrides,
  }
}

/** One env config exactly as `GET …/flags` (the list) returns it. */
function flatEnvConfig(overrides: Record<string, unknown> = {}) {
  return {
    environmentId: 'env_prod',
    enabled: true,
    hasPendingChanges: false,
    schedulingEnabled: false,
    scheduledEnableAt: null,
    scheduledDisableAt: null,
    timezone: null,
    environmentName: 'Production',
    environmentKey: 'production',
    ...overrides,
  }
}

function wireVariation(key: string, value: string) {
  return {
    id: `var_${key}`,
    flagId: 'flag_1',
    name: key,
    key,
    value,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** The list row: flattened environments. */
function listFlag(overrides: Partial<WireFlag> = {}): WireFlag {
  return {
    id: 'flag_1',
    shortId: 12,
    name: 'Checkout v2',
    key: 'checkout_v2',
    type: 'BOOLEAN',
    status: 'RUNNING',
    stale: false,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    variations: [wireVariation('on', 'true'), wireVariation('off', 'false')],
    envConfigs: [flatEnvConfig()],
    ...overrides,
  } as WireFlag
}

/** The single-GET body: nested environments. */
function getFlag(overrides: Partial<WireFlag> = {}): WireFlag {
  return {
    ...listFlag(),
    envConfigs: [nestedEnvConfig()],
    ...overrides,
  } as WireFlag
}

/** The PATCH body: the bare row, no nested blocks at all. */
function patchedFlag(): WireFlag {
  return {
    id: 'flag_1',
    shortId: 12,
    name: 'Checkout v2 renamed',
    key: 'checkout_v2',
    type: 'BOOLEAN',
    status: 'RUNNING',
    stale: false,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-02T00:00:00.000Z',
  }
}

function normalizedFlag(overrides: Partial<WireFlag> = {}): CliFlag {
  return normalizeFlag(getFlag(overrides))
}

describe('normalizeEnvConfig', () => {
  it('reads the nested environment the single-GET and create routes return', () => {
    expect(normalizeEnvConfig(nestedEnvConfig())).toEqual({
      environmentId: 'env_prod',
      environmentKey: 'production',
      environmentName: 'Production',
      enabled: true,
      hasPendingChanges: false,
    })
  })

  it('reads the flattened names the list route returns', () => {
    expect(normalizeEnvConfig(flatEnvConfig({ enabled: false }))).toEqual({
      environmentId: 'env_prod',
      environmentKey: 'production',
      environmentName: 'Production',
      enabled: false,
      hasPendingChanges: false,
    })
  })

  it('falls back to the key for a missing display name', () => {
    expect(
      normalizeEnvConfig({ environmentId: 'env_x', environment: { id: 'env_x', key: 'staging' } })
        .environmentName,
    ).toBe('staging')
  })

  it('treats missing booleans as false rather than undefined', () => {
    const config = normalizeEnvConfig({ environmentId: 'env_x' })

    expect(config.enabled).toBe(false)
    expect(config.hasPendingChanges).toBe(false)
  })
})

describe('normalizeFlag', () => {
  it('produces the same rendered environments from the list body and the get body', () => {
    expect(normalizeFlag(listFlag()).envConfigs).toEqual(normalizeFlag(getFlag()).envConfigs)
  })

  it('survives the PATCH body, which carries no variations or environments', () => {
    const flag = normalizeFlag(patchedFlag())

    expect(flag.variations).toEqual([])
    expect(flag.envConfigs).toEqual([])
    expect(flag.hasEnvironmentData).toBe(false)
  })

  it('separates "no environments" from "the response never said"', () => {
    expect(normalizeFlag(getFlag({ envConfigs: [] })).hasEnvironmentData).toBe(true)
    expect(normalizeFlag(patchedFlag()).hasEnvironmentData).toBe(false)
  })
})

describe('describeEnvState', () => {
  it('names the environments serving the flag', () => {
    const flag = normalizedFlag({
      envConfigs: [
        nestedEnvConfig(),
        nestedEnvConfig({
          environmentId: 'env_stg',
          enabled: false,
          environment: { id: 'env_stg', name: 'Staging', key: 'staging' },
        }),
      ],
    })

    expect(describeEnvState(flag.envConfigs)).toBe('on in production')
  })

  it('collapses the all-on and all-off cases', () => {
    const allOn = normalizedFlag({
      envConfigs: [
        nestedEnvConfig(),
        nestedEnvConfig({
          environmentId: 'env_stg',
          environment: { id: 'env_stg', name: 'Staging', key: 'staging' },
        }),
      ],
    })
    const allOff = normalizedFlag({ envConfigs: [nestedEnvConfig({ enabled: false })] })

    expect(describeEnvState(allOn.envConfigs)).toBe('on everywhere')
    expect(describeEnvState(allOff.envConfigs)).toBe('off everywhere')
  })

  it('says so when a flag has no environments at all', () => {
    expect(describeEnvState([])).toBe('no environments')
  })
})

describe('formatFlagTable', () => {
  it('pads every column to the widest cell so rows line up', () => {
    const [header, ...rows] = formatFlagTable([
      normalizeFlag(listFlag()),
      normalizeFlag(
        listFlag({ shortId: 3, key: 'a_very_long_flag_key_here', type: 'STRING', status: 'DRAFT' }),
      ),
    ])

    expect(header).toContain('ID')
    expect(rows[0].indexOf('BOOLEAN')).toBe(rows[1].indexOf('STRING'))
  })

  it('marks stale flags, which is the whole point of the column', () => {
    const [, row] = formatFlagTable([normalizeFlag(listFlag({ stale: true }))])

    expect(row).toContain('(stale)')
  })

  it('renders a get-shaped flag identically to a list-shaped one', () => {
    expect(formatFlagTable([normalizeFlag(getFlag())])).toEqual(
      formatFlagTable([normalizeFlag(listFlag())]),
    )
  })
})

describe('selectEnvConfig', () => {
  it('matches on the environment key of a GET body, the shape toggle actually reads', () => {
    expect(selectEnvConfig(normalizedFlag(), 'production').environmentId).toBe('env_prod')
  })

  it('matches the display name and the id, case-insensitively', () => {
    expect(selectEnvConfig(normalizedFlag(), 'Production').environmentId).toBe('env_prod')
    expect(selectEnvConfig(normalizedFlag(), 'env_prod').environmentId).toBe('env_prod')
  })

  it('lists what exists when the environment is not found', () => {
    try {
      selectEnvConfig(normalizedFlag(), 'preprod')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).message).toContain('preprod')
      expect((err as CliError).hints.join(' ')).toContain('production')
    }
  })

  it('points at the dashboard when the flag has no environments', () => {
    try {
      selectEnvConfig(normalizeFlag(getFlag({ envConfigs: [] })), 'production')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as CliError).hints.join(' ')).toContain('no environments yet')
    }
  })
})

describe('buildCreateFlagBody', () => {
  it('gives a boolean flag the on/off pair the dashboard would create', () => {
    const body = buildCreateFlagBody({ key: 'checkout_v2' })

    expect(body.type).toBe('BOOLEAN')
    expect(body.variations).toEqual([
      { name: 'on', key: 'on', value: 'true' },
      { name: 'off', key: 'off', value: 'false' },
    ])
    expect(body.defaultVariationKey).toBe('off')
    expect(body.name).toBe('checkout_v2')
  })

  it('parses repeated --variation key=value pairs, keeping values with = in them', () => {
    const body = buildCreateFlagBody({
      key: 'greeting',
      type: 'string',
      variation: ['control=hello', 'variant=a=b'],
      default: 'control',
    })

    expect(body.variations).toEqual([
      { name: 'control', key: 'control', value: 'hello' },
      { name: 'variant', key: 'variant', value: 'a=b' },
    ])
    expect(body.defaultVariationKey).toBe('control')
  })

  it('refuses a non-boolean flag with fewer than two variations', () => {
    expect(() => buildCreateFlagBody({ key: 'greeting', type: 'STRING' })).toThrow(CliError)
  })

  it('refuses a default that is not one of the variations', () => {
    expect(() =>
      buildCreateFlagBody({ key: 'greeting', type: 'STRING', variation: ['a=1', 'b=2'], default: 'c' }),
    ).toThrow(/not one of the variations/)
  })

  it('refuses an unknown type and a malformed variation', () => {
    expect(() => buildCreateFlagBody({ key: 'x', type: 'DECIMAL' })).toThrow(/Invalid --type/)
    expect(() => buildCreateFlagBody({ key: 'x', type: 'STRING', variation: ['justakey'] })).toThrow(
      /Use --variation/,
    )
  })

  it('requires a key', () => {
    expect(() => buildCreateFlagBody({})).toThrow(/flag key is required/)
  })
})

describe('describeTransition', () => {
  it('says plainly when nothing changed, because that is the common CI case', () => {
    expect(
      describeTransition({
        flagKey: 'checkout_v2',
        environmentKey: 'production',
        action: 'pause',
        changed: false,
        affectedRuleCount: 0,
      }),
    ).toBe('checkout_v2 was already paused in production. Nothing changed.')
  })

  it('counts the rules a real change affected', () => {
    expect(
      describeTransition({
        flagKey: 'checkout_v2',
        environmentKey: 'production',
        action: 'run',
        changed: true,
        affectedRuleCount: 1,
      }),
    ).toBe('checkout_v2 is now serving in production (1 rule affected).')
  })

  it('pluralises the rule count', () => {
    expect(
      describeTransition({
        flagKey: 'checkout_v2',
        environmentKey: 'staging',
        action: 'pause',
        changed: true,
        affectedRuleCount: 3,
      }),
    ).toContain('3 rules affected')
  })
})
