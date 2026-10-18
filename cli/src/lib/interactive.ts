/**
 * Whether this run is allowed to ask a question.
 *
 * `avsb init` and `avsb agents-md install` are the first commands with more than
 * one prompt, so the rule they follow is written down once here rather than
 * re-derived per prompt:
 *
 *   a prompt is allowed only when the caller did not pass `--no-input`, the run
 *   is not machine-readable (`--json` implies `--quiet`, see `outputMode.ts`),
 *   stdin is a terminal, and `CI` is not set.
 *
 * Every prompt has a flag equivalent, so a suppressed prompt is never a dead
 * end: the command fails with the flag to pass, or takes the documented default.
 * The check is pure so both halves are tested without a terminal.
 *
 * A prompt asked anyway in a run with no terminal ends in a raw Node warning
 * ("Detected unsettled top-level await") and "User force closed the prompt"
 * (QA N4-15). `refusalWithoutPrompt` is what every confirm uses instead.
 */

import { CliError } from './cliError.js'
import { envFlagEnabled, isQuiet } from './outputMode.js'
import type { CliErrorCode } from '../types/output.js'

export interface PromptContext {
  /** False when `--no-input` was passed. Commander's convention. */
  input: boolean
  /** True in `--json` or `--quiet` mode. */
  quiet: boolean
  /** `process.stdin.isTTY === true`. */
  isTty: boolean
  env: NodeJS.ProcessEnv
}

export function canPrompt(ctx: PromptContext): boolean {
  if (!ctx.input) return false
  if (ctx.quiet) return false
  if (!ctx.isTty) return false
  if (envFlagEnabled(ctx.env.CI)) return false
  return true
}

/** The real process, as a prompt context. */
export function currentPromptContext(options: { input?: boolean } = {}): PromptContext {
  return {
    input: options.input !== false,
    quiet: isQuiet(),
    isTty: process.stdin.isTTY === true,
    env: process.env,
  }
}

/**
 * `canPrompt` against the real process. Called by commands; the pure form above
 * is what the tests drive.
 */
export function isInteractiveRun(options: { input?: boolean } = {}): boolean {
  return canPrompt(currentPromptContext(options))
}

/**
 * The error to stop with when a question cannot be asked, or null when it can.
 *
 * `message` says what was about to be asked; `hints` name the flag or the
 * argument that answers it, so the run is never a dead end.
 */
export function refusalWithoutPrompt(
  refusal: { code: CliErrorCode; message: string; hints: string[] },
  ctx: PromptContext = currentPromptContext(),
): CliError | null {
  if (canPrompt(ctx)) return null
  return new CliError(refusal.code, refusal.message, refusal.hints)
}

/** How long a piped stdin may stay silent before it counts as empty. */
export const STDIN_IDLE_TIMEOUT_MS = 3_000

/**
 * Everything piped to stdin, for `echo "$TOKEN" | avsb login`. Resolves with
 * what arrived when the pipe ends, or with what arrived so far when it stays
 * silent for `idleMs` (a CI runner can leave stdin open with nothing behind
 * it, and a login must not hang there).
 */
export function readPipedStdin(
  stream: NodeJS.ReadableStream = process.stdin,
  idleMs: number = STDIN_IDLE_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (): void => {
      if (timer) clearTimeout(timer)
      stream.removeListener('data', onData)
      stream.removeListener('end', finish)
      stream.removeListener('error', finish)
      if ('pause' in stream && typeof stream.pause === 'function') stream.pause()
      resolve(Buffer.concat(chunks).toString('utf-8'))
    }
    const arm = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(finish, idleMs)
    }
    const onData = (chunk: Buffer | string): void => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      arm()
    }

    stream.on('data', onData)
    stream.once('end', finish)
    stream.once('error', finish)
    arm()
  })
}
