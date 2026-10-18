import { describe, expect, it } from 'vitest'
import {
  GENERATED_MARKER,
  buildReport,
  isGeneratedFile,
  scanFileForReferences,
  type RegistryFlag,
} from './findRefs.js'

const NO_KEYS: ReadonlySet<string> = new Set()

describe('scanFileForReferences — getter calls', () => {
  it('finds a key the platform has never heard of, which is the whole point', () => {
    const src = "const on = useBoolFlag('checkout-v3', false)\n"
    const refs = scanFileForReferences(src, 'src/app.tsx', NO_KEYS)
    expect(refs).toEqual([{ key: 'checkout-v3', file: 'src/app.tsx', line: 1, via: 'getter' }])
  })

  it('reports the line the call is on, not the first line of the file', () => {
    const src = ['// header', '', "client.getStringFlag('hero-copy', 'control')"].join('\n')
    expect(scanFileForReferences(src, 'a.ts', NO_KEYS)[0].line).toBe(3)
  })

  it('reads past the generic argument on a typed getter', () => {
    const src = "getJsonFlag<Theme>('theme', fallback)"
    expect(scanFileForReferences(src, 'a.ts', NO_KEYS)[0].key).toBe('theme')
  })

  it('takes the third argument for the Next server evaluator, not the first', () => {
    const src = "evaluateFlagServer(datafile, context, 'checkout-v2', null)"
    expect(scanFileForReferences(src, 'a.ts', NO_KEYS)[0].key).toBe('checkout-v2')
  })

  it('handles double quotes and backticks the same as single quotes', () => {
    const src = ['useFlag("a-flag", 1)', 'useFlag(`b-flag`, 1)'].join('\n')
    expect(scanFileForReferences(src, 'a.ts', NO_KEYS).map((r) => r.key).sort()).toEqual([
      'a-flag',
      'b-flag',
    ])
  })

  it('requires a word boundary, so a longer identifier is not a flag read', () => {
    const src = "xgetBoolFlag('nope', false)"
    expect(scanFileForReferences(src, 'a.ts', NO_KEYS)).toEqual([])
  })

  it('finds every distinct call in one file', () => {
    const src = ["useBoolFlag('one', false)", "useBoolFlag('two', false)"].join('\n')
    expect(scanFileForReferences(src, 'a.ts', NO_KEYS)).toHaveLength(2)
  })
})

describe('scanFileForReferences — bare literals', () => {
  it('counts a known key read through something that is not a getter', () => {
    const src = "const FLAGS = { primary: 'checkout-v2' }"
    const refs = scanFileForReferences(src, 'config.ts', new Set(['checkout-v2']))
    expect(refs).toEqual([{ key: 'checkout-v2', file: 'config.ts', line: 1, via: 'literal' }])
  })

  it('counts an Angular template attribute, which no call pattern would catch', () => {
    const src = '<div *avsbFlag="\'checkout-v2\'"></div>'
    expect(scanFileForReferences(src, 'a.html', new Set(['checkout-v2']))).toHaveLength(1)
  })

  it('records one finding when a getter and a literal are on the same line', () => {
    const src = "useBoolFlag('checkout-v2', false)"
    const refs = scanFileForReferences(src, 'a.ts', new Set(['checkout-v2']))
    expect(refs).toHaveLength(1)
    expect(refs[0].via).toBe('getter')
  })

  it('ignores an unknown key that is only a bare string', () => {
    const src = "const label = 'checkout-v9'"
    expect(scanFileForReferences(src, 'a.ts', new Set(['checkout-v2']))).toEqual([])
  })
})

describe('isGeneratedFile', () => {
  it('recognises the codegen banner', () => {
    expect(isGeneratedFile(`// ${GENERATED_MARKER}. Do not edit.\n`)).toBe(true)
  })

  it('does not treat a file that merely mentions codegen far down as generated', () => {
    expect(isGeneratedFile(`${'\n'.repeat(500)}// ${GENERATED_MARKER}`)).toBe(false)
  })

  it('skips a generated file entirely, so its own table is not a reference', () => {
    const src = [`// ${GENERATED_MARKER}. Do not edit.`, "  'checkout-v2': boolean"].join('\n')
    expect(scanFileForReferences(src, 'src/generated/flags.ts', new Set(['checkout-v2']))).toEqual(
      [],
    )
  })
})

describe('buildReport', () => {
  const registry: RegistryFlag[] = [
    { key: 'live-flag', status: 'RUNNING' },
    { key: 'draft-flag', status: 'DRAFT', stale: true },
    { key: 'old-flag', status: 'ARCHIVED' },
  ]

  it('reports a referenced key the platform does not have as extinct', () => {
    const report = buildReport(
      registry,
      [{ key: 'gone-flag', file: 'a.ts', line: 3, via: 'getter' }],
      1,
    )
    expect(report.extinct).toEqual([
      {
        key: 'gone-flag',
        reason: 'unknown',
        references: [{ key: 'gone-flag', file: 'a.ts', line: 3, via: 'getter' }],
      },
    ])
  })

  it('reports a referenced archived flag as extinct, with the reason spelled out', () => {
    const report = buildReport(registry, [{ key: 'old-flag', file: 'a.ts', line: 1, via: 'getter' }], 1)
    expect(report.extinct.map((e) => [e.key, e.reason])).toEqual([['old-flag', 'archived']])
  })

  it('lists flags nothing references, and never lists archived ones there', () => {
    const report = buildReport(registry, [{ key: 'live-flag', file: 'a.ts', line: 1, via: 'getter' }], 1)
    expect(report.unreferenced).toEqual([{ key: 'draft-flag', status: 'DRAFT', stale: true }])
    expect(report.matchedKeys).toEqual(['live-flag'])
  })

  it('groups every reference to one key together', () => {
    const report = buildReport(
      registry,
      [
        { key: 'gone-flag', file: 'a.ts', line: 1, via: 'getter' },
        { key: 'gone-flag', file: 'b.ts', line: 9, via: 'literal' },
      ],
      2,
    )
    expect(report.extinct[0].references).toHaveLength(2)
  })

  it('sorts both lists by key so the output is stable between runs', () => {
    const report = buildReport(
      [
        { key: 'zulu', status: 'RUNNING' },
        { key: 'alpha', status: 'RUNNING' },
      ],
      [
        { key: 'zzz-gone', file: 'a.ts', line: 1, via: 'getter' },
        { key: 'aaa-gone', file: 'a.ts', line: 2, via: 'getter' },
      ],
      1,
    )
    expect(report.extinct.map((e) => e.key)).toEqual(['aaa-gone', 'zzz-gone'])
    expect(report.unreferenced.map((f) => f.key)).toEqual(['alpha', 'zulu'])
  })

  it('carries the file count through so a truncated scan can be judged', () => {
    expect(buildReport([], [], 137).filesScanned).toBe(137)
  })
})
