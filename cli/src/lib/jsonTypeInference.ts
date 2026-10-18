/**
 * The TypeScript type of a JSON flag, inferred from the values its variations
 * actually carry.
 *
 * Why infer rather than read a schema: a flag has no declared JSON schema on
 * the platform (the `Flag` model stores variations, not a shape), so the
 * variations ARE the schema. `avsb codegen` used to give up and emit `unknown`
 * for every JSON flag, while the docs promised `{ tiers: number; perks:
 * string[] }` (report 06 §7.20). This module makes the docs true.
 *
 * What it produces, given every variation's value:
 *   [{ tiers: 3, perks: ['a'] }, { tiers: 5, perks: [] }]
 *     -> { perks: string[]; tiers: number }
 *   [{ a: 1 }, { a: 2, b: 'x' }]
 *     -> { a: number; b?: string }        (b is missing from one variation)
 *   [{ a: 1 }, 'plain']
 *     -> { a: number } | string           (variations disagree on shape)
 *
 * Deliberately widened: a string inside JSON becomes `string`, never a literal
 * union. A JSON payload is data, and pinning `"dark" | "light"` on a field
 * would turn adding a third theme into a compile error in code that never
 * needed to change.
 *
 * Bounded on purpose. A JSON flag can hold a whole configuration document, and
 * a 900-line inferred type helps nobody, so depth, key count and total node
 * count are all capped. Past any cap the answer is `unknown`, which is the
 * honest previous behaviour rather than a half-rendered type.
 */

/** How deep into nested objects and arrays the inference goes. */
export const MAX_JSON_DEPTH = 4
/** Objects with more keys than this are not worth rendering as a type. */
export const MAX_JSON_KEYS = 40
/** Total rendered members across the whole type, nested ones included. */
export const MAX_JSON_NODES = 200

/** Thrown internally when a cap is hit; never escapes this module. */
class TooComplex extends Error {}

interface Budget {
  nodes: number
}

/** Values are JSON, so this is the whole universe of shapes. */
type JsonKind = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object'

function kindOf(value: unknown): JsonKind | null {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'boolean':
      return 'boolean'
    case 'number':
      return 'number'
    case 'string':
      return 'string'
    case 'object':
      return 'object'
    default:
      // undefined, function, symbol, bigint: not JSON. Ignored rather than
      // guessed at, so one malformed variation cannot poison the whole type.
      return null
  }
}

/**
 * The TypeScript type covering every value supplied, or `unknown` when the
 * values are absent, unrepresentable, or too large to render usefully.
 */
export function inferJsonType(values: readonly unknown[]): string {
  try {
    return renderUnion(values, 0, { nodes: 0 })
  } catch (err) {
    if (err instanceof TooComplex) return 'unknown'
    throw err
  }
}

/**
 * One type covering all of `values`. Values of the same kind are merged (two
 * objects become one object type with optional members); different kinds
 * become a union.
 */
function renderUnion(values: readonly unknown[], depth: number, budget: Budget): string {
  if (depth > MAX_JSON_DEPTH) throw new TooComplex()

  const byKind = new Map<JsonKind, unknown[]>()
  for (const value of values) {
    const kind = kindOf(value)
    if (kind === null) continue
    const bucket = byKind.get(kind)
    if (bucket) bucket.push(value)
    else byKind.set(kind, [value])
  }

  if (byKind.size === 0) return 'unknown'

  const members: string[] = []
  for (const [kind, bucket] of byKind) {
    members.push(renderKind(kind, bucket, depth, budget))
  }

  // Sorted so the same datafile always emits the same text: `--check` compares
  // bytes, and a Map iteration order that follows variation order would make a
  // reordered dashboard list look like drift.
  members.sort()
  const unique = Array.from(new Set(members))
  return unique.length === 1 ? unique[0] : unique.join(' | ')
}

function renderKind(
  kind: JsonKind,
  values: readonly unknown[],
  depth: number,
  budget: Budget,
): string {
  switch (kind) {
    case 'null':
      return 'null'
    case 'boolean':
      return 'boolean'
    case 'number':
      return 'number'
    case 'string':
      return 'string'
    case 'array':
      return renderArray(values as readonly unknown[][], depth, budget)
    case 'object':
      return renderObject(values as ReadonlyArray<Record<string, unknown>>, depth, budget)
  }
}

function renderArray(arrays: readonly unknown[][], depth: number, budget: Budget): string {
  const elements: unknown[] = []
  for (const array of arrays) elements.push(...array)
  if (elements.length === 0) return 'unknown[]'

  spend(budget)
  const element = renderUnion(elements, depth + 1, budget)
  // `string | number` as an element needs the parentheses; `string` does not.
  return element.includes(' | ') ? `(${element})[]` : `${element}[]`
}

function renderObject(
  objects: ReadonlyArray<Record<string, unknown>>,
  depth: number,
  budget: Budget,
): string {
  const keys = new Set<string>()
  for (const object of objects) {
    for (const key of Object.keys(object)) keys.add(key)
  }
  if (keys.size === 0) return 'Record<string, never>'
  if (keys.size > MAX_JSON_KEYS) throw new TooComplex()

  const members: string[] = []
  for (const key of Array.from(keys).sort()) {
    spend(budget)
    const present = objects.filter((o) => Object.prototype.hasOwnProperty.call(o, key))
    const optional = present.length < objects.length ? '?' : ''
    const type = renderUnion(
      present.map((o) => o[key]),
      depth + 1,
      budget,
    )
    members.push(`${propertyName(key)}${optional}: ${type}`)
  }

  return `{ ${members.join('; ')} }`
}

function spend(budget: Budget): void {
  budget.nodes += 1
  if (budget.nodes > MAX_JSON_NODES) throw new TooComplex()
}

/** `foo` stays bare; anything else is quoted so the emitted type parses. */
export function propertyName(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? key
    : `'${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
