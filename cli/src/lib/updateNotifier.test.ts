import { afterEach, describe, expect, it } from 'vitest'
import {
  isCacheFresh,
  isNewerVersion,
  readCache,
  shouldNotify,
  updateMessage,
} from './updateNotifier.js'
import { resetOutputMode } from './outputMode.js'

afterEach(() => {
  resetOutputMode()
})

describe('isNewerVersion', () => {
  it('compares each part numerically, not as text', () => {
    expect(isNewerVersion('3.10.0', '3.9.9')).toBe(true)
    expect(isNewerVersion('3.9.9', '3.10.0')).toBe(false)
  })

  it('is false for the same version', () => {
    expect(isNewerVersion('3.6.0', '3.6.0')).toBe(false)
  })

  it('ignores a pre-release suffix rather than misreading it', () => {
    expect(isNewerVersion('3.6.0-beta.1', '3.6.0')).toBe(false)
    expect(isNewerVersion('3.7.0-beta.1', '3.6.0')).toBe(true)
  })

  it('treats an unparseable part as zero instead of throwing', () => {
    expect(isNewerVersion('nonsense', '3.6.0')).toBe(false)
  })
})

describe('shouldNotify', () => {
  const base = { quiet: false, isTty: true, env: {} as NodeJS.ProcessEnv }

  it('notifies an interactive run', () => {
    expect(shouldNotify(base)).toBe(true)
  })

  it('never speaks over piped output or in quiet mode', () => {
    expect(shouldNotify({ ...base, isTty: false })).toBe(false)
    expect(shouldNotify({ ...base, quiet: true })).toBe(false)
  })

  it('stays silent in CI and when explicitly switched off', () => {
    expect(shouldNotify({ ...base, env: { CI: '1' } })).toBe(false)
    expect(shouldNotify({ ...base, env: { AVSB_NO_UPDATE_NOTIFIER: 'true' } })).toBe(false)
  })
})

describe('readCache', () => {
  it('reads a well-formed cache', () => {
    expect(readCache(() => JSON.stringify({ checkedAt: 10, latest: '3.7.0' }))).toEqual({
      checkedAt: 10,
      latest: '3.7.0',
    })
  })

  it('treats malformed or unreadable content as no cache, never as a failure', () => {
    expect(readCache(() => 'not json')).toBeNull()
    expect(readCache(() => JSON.stringify({ latest: 3 }))).toBeNull()
    expect(
      readCache(() => {
        throw new Error('ENOENT')
      }),
    ).toBeNull()
  })
})

describe('isCacheFresh', () => {
  it('rechecks once a day', () => {
    const day = 24 * 60 * 60 * 1000
    expect(isCacheFresh({ checkedAt: 0, latest: '3.6.0' }, day - 1)).toBe(true)
    expect(isCacheFresh({ checkedAt: 0, latest: '3.6.0' }, day + 1)).toBe(false)
  })
})

describe('updateMessage', () => {
  it('shows both versions and the exact command to run', () => {
    const message = updateMessage('3.7.0', '3.6.0')

    expect(message).toContain('3.6.0 -> 3.7.0')
    expect(message).toContain('npm install -g @avsbhq/cli')
  })
})
