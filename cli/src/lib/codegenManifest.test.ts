import { describe, expect, it } from 'vitest'
import { MANIFEST_VERSION, buildManifest, serialiseManifest } from './codegenManifest.js'
import type { CodegenDatafile } from './codegenEmit.js'

const datafile: CodegenDatafile = {
  publishedAt: '2026-05-29T00:00:00Z',
  environmentKey: 'production',
  flags: [
    {
      key: 'hero-copy',
      type: 'string',
      enabled: true,
      defaultVariationId: 'var_control',
      variations: [
        { id: 'var_control', key: 'control', value: 'control' },
        { id: 'var_a', key: 'variant-a', value: 'variant-a' },
      ],
    },
    {
      key: 'checkout-v2',
      type: 'boolean',
      enabled: false,
      defaultVariationId: 'var_off',
      variations: [
        { id: 'var_on', key: 'on', value: true },
        { id: 'var_off', key: 'off', value: false },
      ],
    },
  ],
}

function build(df: CodegenDatafile = datafile) {
  return buildManifest({ datafile: df, projectShortId: 42, environmentKey: 'production' })
}

describe('buildManifest', () => {
  it('carries the version, the project, and the environment it read', () => {
    const manifest = build()
    expect(manifest.version).toBe(MANIFEST_VERSION)
    expect(manifest.project).toEqual({ shortId: 42 })
    expect(manifest.environments).toEqual([
      { key: 'production', publishedAt: '2026-05-29T00:00:00Z' },
    ])
  })

  it('sorts flags by key so the file is stable across dashboard reordering', () => {
    expect(build().flags.map((f) => f.key)).toEqual(['checkout-v2', 'hero-copy'])
  })

  it('resolves the default variation from its id', () => {
    const checkout = build().flags.find((f) => f.key === 'checkout-v2')
    expect(checkout?.defaultVariation).toEqual({ key: 'off', value: false })
  })

  it('carries the same TypeScript type the generated file uses', () => {
    const hero = build().flags.find((f) => f.key === 'hero-copy')
    expect(hero?.tsType).toBe("'control' | 'variant-a'")
  })

  it('records enabled per flag and lists the environment it came from', () => {
    const flags = build().flags
    expect(flags.map((f) => f.enabled)).toEqual([false, true])
    expect(flags.every((f) => f.environments.length === 1)).toBe(true)
    expect(flags[0].environments).toEqual(['production'])
  })

  it('reports null rather than guessing when the default variation is unresolvable', () => {
    const manifest = build({
      flags: [
        { key: 'orphan', type: 'boolean', defaultVariationId: 'gone', variations: [{ id: 'a', value: true }] },
        { key: 'no-default', type: 'boolean', variations: [{ id: 'a', value: true }] },
      ],
    })
    expect(manifest.flags[0].defaultVariation).toBeNull()
    expect(manifest.flags[1].defaultVariation).toBeNull()
  })

  it('reports null rather than false when the datafile omits enabled', () => {
    const manifest = build({ flags: [{ key: 'old', type: 'boolean', variations: [{ value: true }] }] })
    expect(manifest.flags[0].enabled).toBeNull()
    expect(manifest.flags[0].variations).toEqual([{ key: null, value: true }])
  })

  it('falls back to the requested environment when the datafile does not name itself', () => {
    const manifest = buildManifest({
      datafile: { flags: [] },
      projectShortId: 7,
      environmentKey: 'staging',
    })
    expect(manifest.environments).toEqual([{ key: 'staging', publishedAt: null }])
  })
})

describe('serialiseManifest', () => {
  it('writes two-space JSON with a trailing newline', () => {
    const text = serialiseManifest(build())
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "version": 1,')
    expect(JSON.parse(text)).toEqual(build())
  })

  it('produces identical bytes for identical input, so --check can compare them', () => {
    expect(serialiseManifest(build())).toBe(serialiseManifest(build()))
  })
})
