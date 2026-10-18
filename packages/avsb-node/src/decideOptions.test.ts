import { describe, expect, it, vi } from 'vitest'
import { DecideOption } from '@avsbhq/core'
import type { DecideOption as DecideOptionValue, Logger } from '@avsbhq/core'
import { createDecideOptionResolver } from './decideOptions'

function makeLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    debug: vi.fn(),
    info: vi.fn(),
    warn: (message: string) => {
      warnings.push(message)
    },
    error: vi.fn(),
    child() {
      return this
    },
  }
}

describe('createDecideOptionResolver', () => {
  it('suppresses exposure for DISABLE_EXPOSURE', () => {
    const resolve = createDecideOptionResolver(makeLogger())
    expect(resolve([DecideOption.DISABLE_EXPOSURE])).toEqual({
      suppressExposure: true,
    })
  })

  it('accepts INCLUDE_REASONS without changing anything, because reasons are always on', () => {
    const logger = makeLogger()
    const resolve = createDecideOptionResolver(logger)

    expect(resolve([DecideOption.INCLUDE_REASONS])).toEqual({
      suppressExposure: false,
    })
    // Accepted, not "unknown": it is real vocabulary for the ports that gate
    // reason collection behind it.
    expect(logger.warnings).toHaveLength(0)
  })

  it('handles both members together', () => {
    const resolve = createDecideOptionResolver(makeLogger())
    expect(
      resolve([DecideOption.INCLUDE_REASONS, DecideOption.DISABLE_EXPOSURE])
    ).toEqual({ suppressExposure: true })
  })

  it('returns the default shape for an empty or missing list', () => {
    const resolve = createDecideOptionResolver(makeLogger())
    expect(resolve(undefined)).toEqual({ suppressExposure: false })
    expect(resolve([])).toEqual({ suppressExposure: false })
  })

  it('warns with the accepted list when a deleted member is passed', () => {
    const logger = makeLogger()
    const resolve = createDecideOptionResolver(logger)

    // A plain-JS caller following an old README. TypeScript rejects it, which
    // is why the cast is here.
    resolve(['IGNORE_STICKY_BUCKET' as DecideOptionValue])

    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toContain('IGNORE_STICKY_BUCKET')
    expect(logger.warnings[0]).toContain('DISABLE_EXPOSURE')
    expect(logger.warnings[0]).toContain('INCLUDE_REASONS')
  })

  it('warns once per unknown value, so a request loop cannot flood the log', () => {
    const logger = makeLogger()
    const resolve = createDecideOptionResolver(logger)

    resolve(['EXCLUDE_VARIABLES' as DecideOptionValue])
    resolve(['EXCLUDE_VARIABLES' as DecideOptionValue])
    resolve(['ENABLED_FLAGS_ONLY' as DecideOptionValue])

    expect(logger.warnings).toHaveLength(2)
  })

  it('still honours the valid members alongside an unknown one', () => {
    const logger = makeLogger()
    const resolve = createDecideOptionResolver(logger)

    expect(
      resolve([
        'NONSENSE' as DecideOptionValue,
        DecideOption.DISABLE_EXPOSURE,
      ])
    ).toEqual({ suppressExposure: true })
    expect(logger.warnings).toHaveLength(1)
  })
})
