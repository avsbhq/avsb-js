import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as logger from './logger.js'
import { resetOutputMode, setOutputMode } from './outputMode.js'

function stdout(): string {
  return vi
    .mocked(process.stdout.write)
    .mock.calls.map((call) => String(call[0]))
    .join('')
}

function stderr(): string {
  return vi
    .mocked(process.stderr.write)
    .mock.calls.map((call) => String(call[0]))
    .join('')
}

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  resetOutputMode()
  vi.restoreAllMocks()
})

describe('stream discipline', () => {
  it('sends results and notes to stdout, warnings and errors to stderr', () => {
    logger.info('working')
    logger.success('done')
    logger.line('row')
    logger.warn('careful')
    logger.error('broke')

    expect(stdout()).toContain('working')
    expect(stdout()).toContain('row')
    expect(stdout()).not.toContain('broke')
    expect(stderr()).toContain('careful')
    expect(stderr()).toContain('broke')
  })
})

describe('--quiet', () => {
  beforeEach(() => {
    setOutputMode({ json: false, quiet: true })
  })

  it('still prints the result, which is what "print only the result" means', () => {
    logger.line('complete -F _avsb_completions avsb')

    expect(stdout()).toContain('complete -F _avsb_completions avsb')
  })

  it('drops decoration: progress notes, headings, labels and blank spacers', () => {
    logger.info('working')
    logger.success('done')
    logger.heading('Organizations')
    logger.label('ID', '42')
    logger.dim('hint')
    logger.line()

    expect(stdout()).toBe('')
  })

  it('still reports failures, because a silent failure is the worst outcome', () => {
    logger.warn('careful')
    logger.error('broke')

    expect(stderr()).toContain('careful')
    expect(stderr()).toContain('broke')
  })
})

describe('--json', () => {
  beforeEach(() => {
    setOutputMode({ json: true, quiet: true })
  })

  it('prints no human output on stdout at all, so the document stays parseable', () => {
    logger.info('working')
    logger.line('row')
    logger.heading('Flags')

    expect(stdout()).toBe('')
  })

  it('keeps errors on stderr for the human watching the log', () => {
    logger.error('broke')

    expect(stderr()).toContain('broke')
  })
})

// QA N4-14: `avsb whoami --quiet` printed nothing at all, because every row of
// its answer was decoration that quiet mode drops.
describe('field, a labelled result line', () => {
  it('prints indented with the label in normal mode', () => {
    logger.field('Email', 'jane@example.com')

    expect(stdout()).toContain('Email:')
    expect(stdout()).toContain('jane@example.com')
  })

  it('keeps the line, plain, under --quiet', () => {
    setOutputMode({ json: false, quiet: true })

    logger.field('Email', 'jane@example.com')
    logger.label('Decoration', 'dropped')

    expect(stdout()).toBe('Email: jane@example.com\n')
  })

  it('prints nothing under --json, where the envelope is the result', () => {
    setOutputMode({ json: true, quiet: true })

    logger.field('Email', 'jane@example.com')

    expect(stdout()).toBe('')
  })
})
