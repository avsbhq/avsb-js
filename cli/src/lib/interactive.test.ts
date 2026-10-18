import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { CliError } from './cliError.js'
import { canPrompt, readPipedStdin, refusalWithoutPrompt, type PromptContext } from './interactive.js'

function ctx(overrides: Partial<PromptContext> = {}): PromptContext {
  return { input: true, quiet: false, isTty: true, env: {}, ...overrides }
}

describe('canPrompt', () => {
  it('allows a question in a normal interactive run', () => {
    expect(canPrompt(ctx())).toBe(true)
  })

  it('refuses when the caller passed --no-input', () => {
    expect(canPrompt(ctx({ input: false }))).toBe(false)
  })

  it('refuses in machine-readable mode, where a prompt would corrupt the output', () => {
    expect(canPrompt(ctx({ quiet: true }))).toBe(false)
  })

  it('refuses when stdin is not a terminal, so a piped run cannot hang', () => {
    expect(canPrompt(ctx({ isTty: false }))).toBe(false)
  })

  it('refuses in CI, whatever the terminal looks like', () => {
    expect(canPrompt(ctx({ env: { CI: 'true' } }))).toBe(false)
    expect(canPrompt(ctx({ env: { CI: '1' } }))).toBe(false)
  })

  it('ignores a CI variable that is explicitly off', () => {
    expect(canPrompt(ctx({ env: { CI: 'false' } }))).toBe(true)
  })
})

describe('refusalWithoutPrompt (QA N4-15)', () => {
  const refusal = {
    code: 'cli_conflict' as const,
    message: 'Pulling would overwrite these local changes, and this run cannot ask first.',
    hints: ['Run `avsb pull --force` to overwrite them,'],
  }

  it('answers null when the run can ask', () => {
    expect(refusalWithoutPrompt(refusal, ctx())).toBeNull()
  })

  it('answers the error, with the flag that answers the question, when it cannot', () => {
    const error = refusalWithoutPrompt(refusal, ctx({ isTty: false }))

    expect(error).toBeInstanceOf(CliError)
    expect(error?.message).toBe(refusal.message)
    expect(error?.hints).toEqual(refusal.hints)
    expect(error?.exitCode).toBe(4)
  })

  it('treats --no-input and CI the same as no terminal', () => {
    expect(refusalWithoutPrompt(refusal, ctx({ input: false }))).not.toBeNull()
    expect(refusalWithoutPrompt(refusal, ctx({ env: { CI: 'true' } }))).not.toBeNull()
  })
})

describe('readPipedStdin', () => {
  it('collects everything piped in until the pipe ends', async () => {
    const stream = new PassThrough()
    const read = readPipedStdin(stream, 1_000)
    stream.write('avsb_pat_')
    stream.end('abc\n')

    expect(await read).toBe('avsb_pat_abc\n')
  })

  it('gives up on a pipe that stays open and silent, instead of hanging', async () => {
    const stream = new PassThrough()

    expect(await readPipedStdin(stream, 20)).toBe('')
  })
})
