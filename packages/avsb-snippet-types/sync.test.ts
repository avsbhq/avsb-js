import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Drift alarm for the snippet's public type declarations.
 *
 * There used to be one hand-maintained copy of `window.avsb`'s shape inside the
 * dashboard editor, and it silently fell behind the runtime: no `track.purchase`,
 * no `track.cart`, no `ready` / `dataset` / `recs` / `commerce` / `exitPreview`,
 * a `getVisitorId` that claimed to return a string while returning null, and a
 * `window.avb` global that never existed (report 01 §5.9).
 *
 * Two things are checked, because there are two ways to drift:
 *
 *  1. The editor's ambient libs are generated copies of this package's files.
 *  2. The declared API members match the runtime's own interfaces in
 *     `snippet/src/types.ts`. That is the check that catches a method added to
 *     the snippet and never declared here.
 *
 * `MIRROR_PAIRS` below is the register of what this file binds. Every "kept in
 * sync by hand" comment in the repo is a pair that belongs in it: a copy nobody
 * checks is a copy that has already drifted, and this is the only place in the
 * tree where such a pair can be written down and enforced without importing
 * across a boundary that must not be crossed (browser code cannot read Prisma,
 * the snippet cannot read the app).
 */

const REPO_ROOT = resolve(__dirname, '..', '..')
const BANNER_PREFIX = '// @generated — do not edit. Source: '

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf-8')
}

function stripBanner(content: string): string {
  if (!content.startsWith(BANNER_PREFIX)) return content
  const newline = content.indexOf('\n')
  return newline === -1 ? '' : content.slice(newline + 1)
}

/**
 * Members declared directly on an interface: the WHOLE normalised line, not
 * just the name.
 *
 * It used to capture the name and its `?` and nothing else, so a member whose
 * TYPE changed on one side passed silently: `getVisitorId(): string` against
 * `getVisitorId(): string | null` was two identical strings to this test. The
 * signature travels with the name now, with runs of whitespace collapsed and a
 * trailing `;` or `,` dropped so formatting alone cannot fail it.
 *
 * Members are read line by line at exactly two spaces of indentation, which is
 * why both files keep one member per line. Comment lines and anything nested
 * deeper are ignored.
 */
function interfaceMembers(
  source: string,
  interfaceName: string,
  resolveAlias: AliasResolver = () => null,
): string[] {
  const start = source.indexOf(`interface ${interfaceName} {`)
  if (start === -1) throw new Error(`interface ${interfaceName} not found`)
  const body = source.slice(start, source.indexOf('\n}', start))
  return joinWrappedMembers(body.split('\n')).map((line) => normaliseMember(line, resolveAlias))
}

/**
 * One member per line, even when the file wrote one across five.
 *
 * `forceVariation` in the runtime takes three parameters and is wrapped, so a
 * strictly line-based read saw `forceVariation: (` and compared that to the
 * package's whole signature. Lines are joined until the brackets balance.
 */
function joinWrappedMembers(lines: string[]): string[] {
  const members: string[] = []
  let buffer: string | null = null
  for (const line of lines) {
    if (buffer === null) {
      if (!/^ {2}[A-Za-z_$][\w$]*\??\s*[:(<]/.test(line)) continue
      buffer = line
    } else {
      buffer += ` ${line.trim()}`
    }
    if (isBalanced(buffer)) {
      members.push(buffer)
      buffer = null
    }
  }
  if (buffer !== null) members.push(buffer)
  return members
}

function isBalanced(text: string): boolean {
  let depth = 0
  for (const char of text) {
    if (char === '(' || char === '{' || char === '[' || char === '<') depth += 1
    if (char === ')' || char === '}' || char === ']' || char === '>') depth -= 1
  }
  return depth <= 0
}

/** Expand a bare type name into what it aliases, or null if it is not one. */
type AliasResolver = (typeName: string) => string | null

/**
 * Put a member line into the one form both sides can be compared in.
 *
 * Three differences between the files are deliberate and systematic, and none
 * of them is drift:
 *
 *  - The package writes a method as `cart(x): void`; the runtime writes the same
 *    member as a property holding a function, `cart: (x) => void`. Both are
 *    rewritten to the property form.
 *  - Every type name in the package carries an `Avsb` prefix, because a global
 *    `.d.ts` shares one namespace with the whole world and `PurchaseOrder` is
 *    not ours to claim. The prefix is stripped.
 *  - One side sometimes names a type the other spells out: `dataset:
 *    DatasetFunction` against `dataset(slug: string): AvsbDatasetHandle`. A
 *    member whose whole type is a bare name is expanded once into what that name
 *    aliases, so the two are compared by what they MEAN. An alias that cannot be
 *    found is left as the bare name, so a rename still fails the test.
 *
 * Everything else survives, which is the point: a changed parameter type, a
 * changed return type or a new optional flag now fails this test, where the old
 * name-only comparison called them identical.
 */
function normaliseMember(line: string, resolveAlias: AliasResolver): string {
  const flat = line
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[;,]$/, '')
    // A member the file wrapped over several lines arrives here with the
    // padding of its own indentation and the trailing comma a multi-line
    // parameter list is written with. Neither is part of the type.
    .replace(/\(\s+/g, '(')
    .replace(/,?\s+\)/g, ')')
  const method = /^([A-Za-z_$][\w$]*\??)\((.*)\):\s*(.+)$/.exec(flat)
  const asProperty = method ? `${method[1]}: (${method[2]}) => ${method[3]}` : flat
  const expanded = expandAlias(asProperty, resolveAlias)
  return expanded.replace(/\bAvsb([A-Z][\w$]*)/g, '$1')
}

function expandAlias(member: string, resolveAlias: AliasResolver): string {
  const bare = /^([A-Za-z_$][\w$]*\??): ([A-Z][\w$]*)$/.exec(member)
  if (!bare) return member
  const body = resolveAlias(bare[2])
  return body === null ? member : `${bare[1]}: ${body}`
}

/** The one-line body of `type X = ...` in this source, or null. */
function typeAliasBody(source: string, typeName: string): string | null {
  const match = new RegExp(`^(?:export )?type ${typeName} = (.+)$`, 'm').exec(source)
  return match ? match[1].replace(/[;,]$/, '').trim() : null
}

/**
 * Follow a type name the runtime imported from a sibling module. `types.ts`
 * re-exports several of its aliases from the file that defines them, so the
 * import line is read rather than a list of files being kept here by hand.
 */
function runtimeAlias(typeName: string): string | null {
  const source = read(RUNTIME_TYPES)
  const local = typeAliasBody(source, typeName)
  if (local) return local
  const imported = new RegExp(
    `^import type \\{[^}]*\\b${typeName}\\b[^}]*\\} from '\\.\\/([\\w/.-]+)'`,
    'm',
  ).exec(source)
  if (!imported) return null
  return typeAliasBody(read(`snippet/src/${imported[1]}.ts`), typeName)
}

function packageAlias(typeName: string): string | null {
  return typeAliasBody(read(PACKAGE_AVSB), typeName)
}

/**
 * The string values of a union type alias, as a sorted set.
 *
 * Deliberately crude, like everything else here: these files live on opposite
 * sides of boundaries that must not be crossed by an import, so text is the
 * only thing both sides can be read as. It accepts both shapes the repo writes
 * a union in (one line, or one member per line) because it reads the quoted
 * values, not the layout.
 */
function unionValues(source: string, typeName: string): string[] {
  const start = source.indexOf(`type ${typeName} =`)
  if (start === -1) throw new Error(`type ${typeName} not found`)
  const body = source.slice(start, findUnionEnd(source, start))
  const values = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1])
  if (values.length === 0) throw new Error(`type ${typeName} declares no string values`)
  return [...values].sort()
}

/** A union ends at the first blank line or the next top-level declaration. */
function findUnionEnd(source: string, start: number): number {
  const rest = source.slice(start)
  const end = rest.search(/\n\s*\n|\n(?:export )?(?:type|interface|const|function|declare) /)
  return end === -1 ? source.length : start + end
}

/**
 * The members of a Prisma enum, as a sorted set. `schema.prisma` is the
 * definition every client-side copy of one of these unions mirrors.
 */
function prismaEnumValues(source: string, enumName: string): string[] {
  const start = source.indexOf(`enum ${enumName} {`)
  if (start === -1) throw new Error(`enum ${enumName} not found`)
  const body = source.slice(start, source.indexOf('\n}', start))
  const values = body
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Z0-9_]*$/.test(line))
  if (values.length === 0) throw new Error(`enum ${enumName} declares no members`)
  return [...values].sort()
}

const PACKAGE_AVSB = 'packages/avsb-snippet-types/avsb.d.ts'
const PACKAGE_VARIATION = 'packages/avsb-snippet-types/variation-code.d.ts'
const EDITOR_AVSB = 'snippet/types/avsb.d.ts'
const EDITOR_VARIATION = 'snippet/types/variation-code.d.ts'
const RUNTIME_TYPES = 'snippet/src/types.ts'
const PRISMA_SCHEMA = 'prisma/schema.prisma'
const APP_METRIC_TYPES = 'app/_types/metric.ts'
const APP_EXPERIMENT_TYPES = 'app/_types/experiment.ts'
const APP_VISUAL_EDITOR_TYPES = 'app/_types/visualEditor.ts'

/**
 * The register of mirrored declarations this file binds.
 *
 * Each entry is one pair that a person keeps in step by hand, with the
 * extractor that reads both sides. Adding a row is how a new "kept in sync"
 * comment stops being a promise and starts being a test. `read` is deliberately
 * text-level for every row: these files sit on opposite sides of boundaries an
 * import must not cross, which is exactly why they drifted in the first place.
 */
const MIRROR_PAIRS: ReadonlyArray<{
  name: string
  reason: string
  left: () => string[]
  right: () => string[]
}> = [
  {
    name: 'AvsbApi (package) ↔ AvsbPublicAPI (runtime)',
    reason: 'a method added to the snippet and never declared for consumers',
    left: () => interfaceMembers(read(PACKAGE_AVSB), 'AvsbApi', packageAlias),
    right: () => interfaceMembers(read(RUNTIME_TYPES), 'AvsbPublicAPI', runtimeAlias),
  },
  {
    name: 'AvsbTrackFunction (package) ↔ TrackFunction (runtime)',
    reason: 'a tracking call whose arguments changed on one side only',
    left: () => interfaceMembers(read(PACKAGE_AVSB), 'AvsbTrackFunction', packageAlias),
    right: () => interfaceMembers(read(RUNTIME_TYPES), 'TrackFunction', runtimeAlias),
  },
  {
    name: 'AvsbDecisionStatus (package) ↔ DecisionStatus (runtime)',
    reason: 'a decision status the snippet reports and consumers cannot name',
    left: () => unionValues(read(PACKAGE_AVSB), 'AvsbDecisionStatus'),
    right: () => unionValues(read(RUNTIME_TYPES), 'DecisionStatus'),
  },
  {
    name: 'MetricType (schema) ↔ MetricType (app/_types)',
    reason: 'the literal mirror browser code reads instead of the Prisma enum',
    left: () => prismaEnumValues(read(PRISMA_SCHEMA), 'MetricType'),
    right: () => unionValues(read(APP_METRIC_TYPES), 'MetricType'),
  },
  {
    name: 'ExperimentType (schema) ↔ ExperimentType (app/_types)',
    reason: 'same literal-mirror policy, same drift risk',
    left: () => prismaEnumValues(read(PRISMA_SCHEMA), 'ExperimentType'),
    right: () => unionValues(read(APP_EXPERIMENT_TYPES), 'ExperimentType'),
  },
  {
    name: 'EditorMode (schema) ↔ EditorMode (app/_types)',
    reason: 'same literal-mirror policy, same drift risk',
    left: () => prismaEnumValues(read(PRISMA_SCHEMA), 'EditorMode'),
    right: () => unionValues(read(APP_VISUAL_EDITOR_TYPES), 'EditorMode'),
  },
]

describe('editor ambient libs are generated copies', () => {
  it('mirrors the window.avsb declarations byte for byte after the banner', () => {
    expect(stripBanner(read(EDITOR_AVSB))).toBe(read(PACKAGE_AVSB))
  })

  it('mirrors the variation-authoring declarations byte for byte after the banner', () => {
    expect(stripBanner(read(EDITOR_VARIATION))).toBe(read(PACKAGE_VARIATION))
  })

  it('marks both copies as generated so nobody hand-edits them again', () => {
    expect(read(EDITOR_AVSB).startsWith(BANNER_PREFIX)).toBe(true)
    expect(read(EDITOR_VARIATION).startsWith(BANNER_PREFIX)).toBe(true)
  })
})

describe('every mirrored declaration in the register still agrees', () => {
  it.each(MIRROR_PAIRS)('$name: $reason', ({ left, right }) => {
    expect([...left()].sort()).toEqual([...right()].sort())
  })

  it('reads real content on both sides of every pair', () => {
    // A pair whose extractor silently returned nothing would pass the check
    // above while binding nothing at all, which is the failure mode a registry
    // of text extractors has.
    for (const pair of MIRROR_PAIRS) {
      expect(pair.left().length, pair.name).toBeGreaterThan(0)
      expect(pair.right().length, pair.name).toBeGreaterThan(0)
    }
  })
})

describe('declared API matches the snippet runtime', () => {

  it('has no ghost globals: window.avb is gone for good', () => {
    // The old hand-written mirror declared `avb?: { q?: ... }`. Nothing in the
    // runtime has ever read that name.
    expect(read(PACKAGE_AVSB)).not.toContain('avb')
    expect(read(EDITOR_AVSB)).not.toContain('avb')
  })

  it('types getVisitorId as nullable, matching what the runtime returns', () => {
    expect(read(PACKAGE_AVSB)).toContain('getVisitorId(): string | null')
  })

  it('stays a global script, not a module, or every type name would be hidden', () => {
    // A single `export` turns a .d.ts into a module: the names stop being global,
    // `interface Window` stops merging with the browser's, and consumers who
    // followed the documented `types` setup silently get nothing.
    for (const file of [PACKAGE_AVSB, PACKAGE_VARIATION, EDITOR_AVSB, EDITOR_VARIATION]) {
      const source = read(file)
      expect(source, file).not.toMatch(/^export /m)
      expect(source, file).not.toMatch(/^import /m)
      expect(source, file).not.toContain('declare global')
    }
  })
})
