/**
 * Presentation and input parsing for `avsb flags`. Kept out of `flags.ts` so
 * the command file is commander wiring and everything decided here is testable
 * without a network.
 */

import { CliError } from '../lib/cliError.js'
import type {
  CliFlag,
  CliFlagEnvConfig,
  CliFlagType,
  CreateFlagBody,
  WireFlag,
  WireFlagEnvConfig,
} from '../types/flag.js'

export const FLAG_TYPES: readonly CliFlagType[] = ['BOOLEAN', 'STRING', 'NUMBER', 'JSON'] as const

/**
 * One environment config, from either wire shape.
 *
 * The list route flattens `environmentKey`/`environmentName`; the single-GET and
 * create routes return the stored row with the relation nested under
 * `environment`. Reading only the flattened names is what made `avsb flags
 * toggle` crash on a `get` body, so both are read here, once.
 */
export function normalizeEnvConfig(wire: WireFlagEnvConfig): CliFlagEnvConfig {
  const key = wire.environmentKey ?? wire.environment?.key ?? ''
  return {
    environmentId: wire.environmentId ?? wire.environment?.id ?? '',
    environmentKey: key,
    environmentName: wire.environmentName ?? wire.environment?.name ?? key,
    enabled: wire.enabled === true,
    hasPendingChanges: wire.hasPendingChanges === true,
  }
}

/**
 * A flag from any of the three routes, in the shape the CLI renders.
 *
 * `hasEnvironmentData` records the difference between "this flag has no
 * environments" and "this response never carried any" (the PATCH body), so the
 * printed output can say which is true instead of implying the first.
 */
export function normalizeFlag(wire: WireFlag): CliFlag {
  return {
    id: wire.id,
    shortId: wire.shortId,
    name: wire.name,
    key: wire.key,
    type: wire.type,
    status: wire.status,
    stale: wire.stale === true,
    description: wire.description ?? null,
    variations: wire.variations ?? [],
    envConfigs: (wire.envConfigs ?? []).map(normalizeEnvConfig),
    hasEnvironmentData: Array.isArray(wire.envConfigs),
  }
}

/** `FLG-12` in a list, matching how every other resource prints its short id. */
export function flagIdLabel(flag: Pick<CliFlag, 'shortId'>): string {
  return `FLG-${flag.shortId}`
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max - 1) + '…'
}

/**
 * Which environments are serving this flag right now, as one cell.
 *
 * `production, staging` reads better than a boolean column per environment, and
 * it stays honest when a project has five of them.
 */
export function describeEnvState(envConfigs: CliFlagEnvConfig[]): string {
  if (envConfigs.length === 0) return 'no environments'
  const on = envConfigs
    .filter((env) => env.enabled)
    .map((env) => env.environmentKey || env.environmentId || 'unnamed')
  if (on.length === 0) return 'off everywhere'
  if (on.length === envConfigs.length) return 'on everywhere'
  return `on in ${on.join(', ')}`
}

/** The header plus one line per flag, already padded. */
export function formatFlagTable(flags: CliFlag[]): string[] {
  const rows = flags.map((flag) => ({
    id: flagIdLabel(flag),
    key: truncate(flag.key, 32),
    type: flag.type,
    status: flag.status,
    envs: describeEnvState(flag.envConfigs),
    stale: flag.stale,
  }))

  const widths = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    key: Math.max(3, ...rows.map((r) => r.key.length)),
    type: Math.max(4, ...rows.map((r) => r.type.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
  }

  const header = [
    'ID'.padEnd(widths.id),
    'Key'.padEnd(widths.key),
    'Type'.padEnd(widths.type),
    'Status'.padEnd(widths.status),
    'Environments',
  ].join('  ')

  const lines = rows.map((row) => {
    const line = [
      row.id.padEnd(widths.id),
      row.key.padEnd(widths.key),
      row.type.padEnd(widths.type),
      row.status.padEnd(widths.status),
      row.envs,
    ].join('  ')
    return row.stale ? `${line}  (stale)` : line
  })

  return [header, ...lines]
}

/**
 * Find the environment a `--env` value names.
 *
 * Matches the environment key first (`production`), then its name, then its
 * cuid, because the key is what a developer knows. A miss lists what exists,
 * which is the only useful answer.
 */
export function selectEnvConfig(flag: CliFlag, envRef: string): CliFlagEnvConfig {
  const needle = envRef.trim().toLowerCase()
  const found =
    flag.envConfigs.find((env) => env.environmentKey.toLowerCase() === needle) ??
    flag.envConfigs.find((env) => env.environmentName.toLowerCase() === needle) ??
    flag.envConfigs.find((env) => env.environmentId === envRef.trim())

  if (found) return found

  const known = flag.envConfigs
    .map((env) => env.environmentKey)
    .filter((key) => key.length > 0)
    .join(', ')
  throw new CliError(
    'cli_not_found',
    `Flag ${flag.key} has no environment "${envRef}".`,
    known.length > 0
      ? [`This flag's environments: ${known}.`]
      : ['This flag has no environments yet. Add one in the dashboard first.'],
  )
}

export interface CreateFlagOptions {
  key?: string
  name?: string
  description?: string
  type?: string
  variation?: string[]
  default?: string
}

const VARIATION_FORM = '--variation <key>=<value>'

/**
 * Build the create body from repeated `--variation key=value` flags.
 *
 * Boolean flags need no variations at all: `on=true` and `off=false` are what
 * the dashboard creates, so the CLI creates the same pair rather than making
 * the common case type them out.
 */
export function buildCreateFlagBody(opts: CreateFlagOptions): CreateFlagBody {
  const key = opts.key?.trim()
  if (!key) {
    throw new CliError('cli_usage', 'A flag key is required: `avsb flags create <key>`.')
  }

  const rawType = (opts.type ?? 'BOOLEAN').toUpperCase()
  if (!FLAG_TYPES.includes(rawType as CliFlagType)) {
    throw new CliError(
      'cli_usage',
      `Invalid --type "${opts.type}". Must be one of: ${FLAG_TYPES.join(' | ')}`,
    )
  }
  const type = rawType as CliFlagType

  const variations = (opts.variation ?? []).map((raw) => {
    const separator = raw.indexOf('=')
    if (separator < 1) {
      throw new CliError('cli_usage', `Invalid variation "${raw}". Use ${VARIATION_FORM}.`)
    }
    const variationKey = raw.slice(0, separator).trim()
    const value = raw.slice(separator + 1)
    if (!variationKey) {
      throw new CliError('cli_usage', `Invalid variation "${raw}". Use ${VARIATION_FORM}.`)
    }
    return { name: variationKey, key: variationKey, value }
  })

  const resolved =
    variations.length > 0
      ? variations
      : type === 'BOOLEAN'
        ? [
            { name: 'on', key: 'on', value: 'true' },
            { name: 'off', key: 'off', value: 'false' },
          ]
        : []

  if (resolved.length < 2) {
    throw new CliError(
      'cli_usage',
      `A ${type} flag needs at least two variations. Pass them as ${VARIATION_FORM}, repeated.`,
    )
  }

  const defaultVariationKey = opts.default?.trim() ?? resolved[resolved.length - 1].key
  if (!resolved.some((variation) => variation.key === defaultVariationKey)) {
    throw new CliError(
      'cli_usage',
      `--default "${defaultVariationKey}" is not one of the variations (${resolved
        .map((variation) => variation.key)
        .join(', ')}).`,
    )
  }

  return {
    name: opts.name?.trim() || key,
    key,
    description: opts.description ?? undefined,
    type,
    variations: resolved,
    defaultVariationKey,
  }
}

/** What a toggle actually did, in one line. */
export function describeTransition(input: {
  flagKey: string
  environmentKey: string
  action: 'run' | 'pause'
  changed: boolean
  affectedRuleCount: number
}): string {
  const verb = input.action === 'run' ? 'serving' : 'paused'
  if (!input.changed) {
    return `${input.flagKey} was already ${verb} in ${input.environmentKey}. Nothing changed.`
  }
  const rules =
    input.affectedRuleCount === 1 ? '1 rule' : `${input.affectedRuleCount} rules`
  return `${input.flagKey} is now ${verb} in ${input.environmentKey} (${rules} affected).`
}
