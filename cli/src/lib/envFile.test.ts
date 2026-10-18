import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyEnvAssignment,
  describeEnvWrite,
  ENV_BANNER,
  formatEnvValue,
  readEnvAssignment,
  writeEnvAssignment,
} from './envFile.js'

const KEY = 'sdk_production_ttqm0eaj4vth1krcb2xn'

describe('readEnvAssignment', () => {
  it('reads a plain assignment, an exported one, and a quoted value', () => {
    expect(readEnvAssignment('AVSB_SDK_KEY=abc', 'AVSB_SDK_KEY')).toBe('abc')
    expect(readEnvAssignment('export AVSB_SDK_KEY=abc', 'AVSB_SDK_KEY')).toBe('abc')
    expect(readEnvAssignment('AVSB_SDK_KEY="abc"', 'AVSB_SDK_KEY')).toBe('abc')
  })

  it('ignores commented lines, so a disabled key is not read as set', () => {
    expect(readEnvAssignment('# AVSB_SDK_KEY=old\nOTHER=1', 'AVSB_SDK_KEY')).toBeNull()
  })

  it('does not confuse a variable with one whose name it is a prefix of', () => {
    expect(readEnvAssignment('NEXT_PUBLIC_AVSB_SDK_KEY=abc', 'AVSB_SDK_KEY')).toBeNull()
  })
})

describe('applyEnvAssignment', () => {
  it('creates the file with a banner when there is nothing yet', () => {
    const result = applyEnvAssignment(null, 'AVSB_SDK_KEY', KEY)

    expect(result.outcome).toBe('created')
    expect(result.content).toBe(`${ENV_BANNER}\nAVSB_SDK_KEY=${KEY}\n`)
  })

  it('appends under a banner and keeps every existing line', () => {
    const existing = 'DATABASE_URL=postgres://localhost/dev\n'
    const result = applyEnvAssignment(existing, 'AVSB_SDK_KEY', KEY)

    expect(result.outcome).toBe('appended')
    expect(result.content.startsWith(existing)).toBe(true)
    expect(result.content).toContain(`AVSB_SDK_KEY=${KEY}`)
  })

  it('adds the missing newline when the file does not end with one', () => {
    const result = applyEnvAssignment('DATABASE_URL=x', 'AVSB_SDK_KEY', KEY)

    expect(result.content).toBe(`DATABASE_URL=x\n\n${ENV_BANNER}\nAVSB_SDK_KEY=${KEY}\n`)
  })

  it('leaves the file alone when the same key is already set', () => {
    const existing = `AVSB_SDK_KEY=${KEY}\n`
    const result = applyEnvAssignment(existing, 'AVSB_SDK_KEY', KEY)

    expect(result.outcome).toBe('unchanged')
    expect(result.content).toBe(existing)
  })

  it('refuses to repoint an app at another environment, and says what is there', () => {
    const existing = 'AVSB_SDK_KEY=sdk_development_other\n'
    const result = applyEnvAssignment(existing, 'AVSB_SDK_KEY', KEY)

    expect(result.outcome).toBe('conflict')
    expect(result.content).toBe(existing)
    expect(result.existingValue).toBe('sdk_development_other')
  })

  it('recognises its own quoted line, so a value that needed escaping round-trips', () => {
    // Written as `"a\"b c"`. Read back, it has to compare equal to `a"b c`, or
    // the CLI reports a conflict against a line it wrote itself.
    const awkward = 'a"b c'
    const written = applyEnvAssignment(null, 'AVSB_SDK_KEY', awkward)
    const again = applyEnvAssignment(written.content, 'AVSB_SDK_KEY', awkward)

    expect(written.content).toContain('AVSB_SDK_KEY="a\\"b c"')
    expect(again.outcome).toBe('unchanged')
    expect(again.content).toBe(written.content)
  })

  it('still calls a genuinely different quoted value a conflict', () => {
    const written = applyEnvAssignment(null, 'AVSB_SDK_KEY', 'a"b c')
    const other = applyEnvAssignment(written.content, 'AVSB_SDK_KEY', 'a"b d')

    expect(other.outcome).toBe('conflict')
    expect(other.existingValue).toBe('a"b c')
  })
})

describe('formatEnvValue', () => {
  it('leaves an SDK key unquoted and quotes anything that would break the line', () => {
    expect(formatEnvValue(KEY)).toBe(KEY)
    expect(formatEnvValue('two words')).toBe('"two words"')
    expect(formatEnvValue('has"quote')).toBe('"has\\"quote"')
  })
})

describe('writeEnvAssignment', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avsb-init-env-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('creates the file, then leaves it byte-identical on a second run', () => {
    const first = writeEnvAssignment({ dir, file: '.env.local', name: 'AVSB_SDK_KEY', value: KEY })
    const afterFirst = fs.readFileSync(first.filePath, 'utf-8')

    const second = writeEnvAssignment({ dir, file: '.env.local', name: 'AVSB_SDK_KEY', value: KEY })

    expect(first.outcome).toBe('created')
    expect(first.wrote).toBe(true)
    expect(second.outcome).toBe('unchanged')
    expect(second.wrote).toBe(false)
    expect(fs.readFileSync(second.filePath, 'utf-8')).toBe(afterFirst)
  })

  it('never touches an existing variable set to a different key', () => {
    const filePath = path.join(dir, '.env')
    fs.writeFileSync(filePath, 'AVSB_SDK_KEY=sdk_development_other\n', 'utf-8')

    const result = writeEnvAssignment({ dir, file: '.env', name: 'AVSB_SDK_KEY', value: KEY })

    expect(result.outcome).toBe('conflict')
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('AVSB_SDK_KEY=sdk_development_other\n')
  })

  it('keeps the developer s other variables when it appends', () => {
    const filePath = path.join(dir, '.env')
    fs.writeFileSync(filePath, 'STRIPE_KEY=sk_test_123\n', 'utf-8')

    writeEnvAssignment({ dir, file: '.env', name: 'AVSB_SDK_KEY', value: KEY })

    const written = fs.readFileSync(filePath, 'utf-8')
    expect(written).toContain('STRIPE_KEY=sk_test_123')
    expect(written).toContain(`AVSB_SDK_KEY=${KEY}`)
  })

  it('creates the directory when the environment file sits in one', () => {
    const result = writeEnvAssignment({
      dir,
      file: 'config/.env',
      name: 'AVSB_SDK_KEY',
      value: KEY,
    })

    expect(fs.existsSync(result.filePath)).toBe(true)
  })
})

describe('describeEnvWrite', () => {
  it('says what happened for every outcome, including the two that wrote nothing', () => {
    const base = { filePath: '/app/.env', content: '', existingValue: null, wrote: false }

    expect(describeEnvWrite({ ...base, outcome: 'created' }, 'AVSB_SDK_KEY')).toContain('Created')
    expect(describeEnvWrite({ ...base, outcome: 'appended' }, 'AVSB_SDK_KEY')).toContain('Added')
    expect(describeEnvWrite({ ...base, outcome: 'unchanged' }, 'AVSB_SDK_KEY')).toContain(
      'Left alone',
    )
    expect(describeEnvWrite({ ...base, outcome: 'conflict' }, 'AVSB_SDK_KEY')).toContain(
      'different key',
    )
  })
})
