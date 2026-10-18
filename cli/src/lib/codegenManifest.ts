/**
 * The flag manifest: the same datafile facts as the generated types, in JSON,
 * for the tools that cannot read TypeScript.
 *
 * The `.ts` file is for your editor. The manifest is for everything else: a CI
 * job asserting a flag exists before a deploy, a script listing what is still
 * serving a default variation, a dashboard of flag counts per environment. All
 * of it becomes `jq` against one committed file instead of another API token.
 *
 * DETERMINISTIC BY CONSTRUCTION. Nothing here reads the clock, the CLI version,
 * or the machine: two runs against the same datafile produce the same bytes.
 * That is what lets `avsb codegen --check` compare the manifest the same way it
 * compares the types, and what stops a CLI upgrade from looking like drift.
 */

import { tsTypeForFlag, type CodegenDatafile, type DatafileFlag } from './codegenEmit.js'
import { compareCodeUnits } from './compareKeys.js'

/** Bumped only when a field is removed or changes meaning; additions are free. */
export const MANIFEST_VERSION = 1

export interface ManifestVariation {
  /** The variation key, or null on a datafile old enough to omit it. */
  key: string | null
  value: unknown
}

export interface ManifestFlag {
  key: string
  type: 'boolean' | 'string' | 'number' | 'json'
  /** The TypeScript type the generated file gives this flag, as text. */
  tsType: string
  /** Whether the flag serves rules here. Null when the datafile omits it. */
  enabled: boolean | null
  /** What the flag answers when no rule matches. Null when unresolvable. */
  defaultVariation: ManifestVariation | null
  variations: ManifestVariation[]
  /** Which of the environments below carry this flag. */
  environments: string[]
}

export interface ManifestEnvironment {
  key: string
  publishedAt: string | null
}

export interface FlagManifest {
  version: typeof MANIFEST_VERSION
  project: { shortId: number }
  /**
   * The environments this manifest was generated from. One entry today, since
   * one run reads one environment; the array shape is what lets a later
   * multi-environment run add entries without changing the contract.
   */
  environments: ManifestEnvironment[]
  flags: ManifestFlag[]
}

export interface ManifestInput {
  datafile: CodegenDatafile
  projectShortId: number
  /** The environment asked for, used when the datafile does not name itself. */
  environmentKey: string
}

export function buildManifest(input: ManifestInput): FlagManifest {
  const envKey = input.datafile.environmentKey ?? input.environmentKey

  return {
    version: MANIFEST_VERSION,
    project: { shortId: input.projectShortId },
    environments: [{ key: envKey, publishedAt: input.datafile.publishedAt ?? null }],
    flags: [...input.datafile.flags]
      .sort((a, b) => compareCodeUnits(a.key, b.key))
      .map((flag) => buildManifestFlag(flag, envKey)),
  }
}

function buildManifestFlag(flag: DatafileFlag, environmentKey: string): ManifestFlag {
  const variations = flag.variations.map((v) => ({ key: v.key ?? null, value: v.value }))

  return {
    key: flag.key,
    type: flag.type,
    tsType: tsTypeForFlag(flag),
    enabled: flag.enabled ?? null,
    defaultVariation: resolveDefaultVariation(flag),
    variations,
    environments: [environmentKey],
  }
}

/**
 * Which variation answers when no rule matches.
 *
 * Returns null rather than guessing when the datafile carries no
 * `defaultVariationId`, or names one that is not in the list. "We do not know"
 * is a fact a CI script can branch on; a fabricated first-variation default is
 * not.
 */
function resolveDefaultVariation(flag: DatafileFlag): ManifestVariation | null {
  if (!flag.defaultVariationId) return null
  const match = flag.variations.find((v) => v.id === flag.defaultVariationId)
  if (!match) return null
  return { key: match.key ?? null, value: match.value }
}

/** The manifest as it is written to disk: two-space JSON, trailing newline. */
export function serialiseManifest(manifest: FlagManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}
