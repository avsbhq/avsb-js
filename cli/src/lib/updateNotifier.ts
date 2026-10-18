/**
 * Telling you, once a day at most, that a newer CLI exists.
 *
 * Rules, in order of importance:
 *   1. It never blocks a command. The check is skipped entirely unless a cached
 *      answer is already on disk; the refresh happens after the command's work.
 *   2. It never speaks in a script. `--json`, `--quiet`, a non-interactive
 *      stderr, `CI=1` and `AVSB_NO_UPDATE_NOTIFIER=1` all silence it.
 *   3. It never fails a command. A registry that is down, a read-only home
 *      directory, or a malformed cache are all non-events.
 *
 * The notice goes to stderr, like every other note about the run.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { envFlagEnabled, isQuiet } from './outputMode.js'

const REGISTRY_URL = 'https://registry.npmjs.org/@avsbhq/cli/latest'
const CACHE_FILE = path.join(os.homedir(), '.avsb', 'update-check.json')
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 1500

export interface UpdateCache {
  /** Epoch millis of the last successful check. */
  checkedAt: number
  latest: string
}

/** Compare two `major.minor.patch` strings. Pre-release suffixes are ignored. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (value: string): number[] =>
    value
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0))

  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  return false
}

/**
 * Whether a notice may be printed at all. Pure, so every reason to stay quiet
 * is testable.
 */
export function shouldNotify(input: {
  quiet: boolean
  isTty: boolean
  env: NodeJS.ProcessEnv
}): boolean {
  if (input.quiet) return false
  if (!input.isTty) return false
  if (envFlagEnabled(input.env.AVSB_NO_UPDATE_NOTIFIER)) return false
  if (envFlagEnabled(input.env.CI)) return false
  return true
}

export function readCache(readFile: () => string): UpdateCache | null {
  try {
    const parsed: unknown = JSON.parse(readFile())
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as UpdateCache).latest === 'string' &&
      typeof (parsed as UpdateCache).checkedAt === 'number'
    ) {
      return parsed as UpdateCache
    }
    return null
  } catch {
    return null
  }
}

export function isCacheFresh(cache: UpdateCache, now: number): boolean {
  return now - cache.checkedAt < CHECK_INTERVAL_MS
}

/** The one line printed when a newer version exists. */
export function updateMessage(latest: string, current: string): string {
  return `A newer @avsbhq/cli is available: ${current} -> ${latest}. Update with \`npm install -g @avsbhq/cli\`.`
}

function writeCache(cache: UpdateCache): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache))
  } catch {
    // A cache that cannot be written just means checking again tomorrow.
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    if (!res.ok) return null
    const body: unknown = await res.json()
    const version = (body as { version?: unknown }).version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/**
 * Print the notice if the cached answer says one is due, then refresh the cache
 * in the background. Awaiting this is optional and it never rejects.
 */
export async function checkForUpdate(
  currentVersion: string,
  notify: (message: string) => void,
): Promise<void> {
  if (!shouldNotify({ quiet: isQuiet(), isTty: process.stderr.isTTY === true, env: process.env })) {
    return
  }

  let cache: UpdateCache | null = null
  try {
    cache = readCache(() => fs.readFileSync(CACHE_FILE, 'utf-8'))
  } catch {
    cache = null
  }

  if (cache && isNewerVersion(cache.latest, currentVersion)) {
    notify(updateMessage(cache.latest, currentVersion))
  }

  if (cache && isCacheFresh(cache, Date.now())) return

  const latest = await fetchLatestVersion()
  if (latest) writeCache({ checkedAt: Date.now(), latest })
}
