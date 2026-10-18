/**
 * `avsb codegen --check`: regenerate in memory, compare to what is committed,
 * and say exactly which file drifted and where.
 *
 * The failure this exists to catch is not "someone edited the generated file".
 * It is "a flag was renamed on the platform three weeks ago and the checked-in
 * types still name the old one", which shows up as a runtime default served to
 * real users instead of a red build.
 *
 * Pure: comparison in, report out. The command does the reading and the exit
 * code, so every branch here is testable without a filesystem.
 */

/** One file codegen would write, next to what is on disk right now. */
export interface CodegenArtifact {
  /** Absolute path. Printed as-is, so the message is copy-pasteable. */
  path: string
  /** What codegen produces from the live datafile. */
  expected: string
  /** The file's contents, or null when it does not exist. */
  actual: string | null
}

export type DriftReason = 'missing' | 'different'

export interface CodegenDrift {
  path: string
  reason: DriftReason
  /** 1-based line of the first difference. Null when the file is missing. */
  line: number | null
  /** The generated line at that position, or null when generation is shorter. */
  expectedLine: string | null
  /** The on-disk line at that position, or null when the file is shorter. */
  actualLine: string | null
  expectedLineCount: number
  actualLineCount: number | null
}

/**
 * The publish stamp in a generated file (`publishedAt=` in the types header,
 * `"publishedAt"` in the manifest) says when the environment was last
 * published, not what the file contains. `--check` compares contents, so a
 * file whose only difference is that stamp, because the environment was
 * published again with the same flags, is up to date and does not fail a CI
 * build (QA N4-5). Line structure is kept, so line numbers still match.
 */
export function withoutPublishStamp(text: string): string {
  return text
    .replace(/^(\/\/ Source: .*\bpublishedAt=)\S+/m, '$1*')
    .replace(/^(\s*"publishedAt": )(?:"[^"\n]*"|null)/gm, '$1*')
}

/**
 * Compare one artifact.
 *
 * Line endings are normalised on the disk side before comparing. A Windows
 * checkout with `core.autocrlf` rewrites every generated file on checkout, and
 * failing that build teaches people to ignore the check rather than to
 * regenerate. Content differences are still caught byte for byte; only the
 * publish stamp is left out (see `withoutPublishStamp`).
 */
export function diffArtifact(artifact: CodegenArtifact): CodegenDrift | null {
  const expectedLines = artifact.expected.split('\n')

  if (artifact.actual === null) {
    return {
      path: artifact.path,
      reason: 'missing',
      line: null,
      expectedLine: null,
      actualLine: null,
      expectedLineCount: expectedLines.length,
      actualLineCount: null,
    }
  }

  const actual = artifact.actual.replace(/\r\n/g, '\n')
  const expectedComparable = withoutPublishStamp(artifact.expected).split('\n')
  const actualComparable = withoutPublishStamp(actual).split('\n')
  if (expectedComparable.join('\n') === actualComparable.join('\n')) return null

  const actualLines = actual.split('\n')
  const shared = Math.min(expectedComparable.length, actualComparable.length)

  let index = 0
  while (index < shared && expectedComparable[index] === actualComparable[index]) index += 1

  return {
    path: artifact.path,
    reason: 'different',
    line: index + 1,
    expectedLine: index < expectedLines.length ? expectedLines[index] : null,
    actualLine: index < actualLines.length ? actualLines[index] : null,
    expectedLineCount: expectedLines.length,
    actualLineCount: actualLines.length,
  }
}

export function diffArtifacts(artifacts: readonly CodegenArtifact[]): CodegenDrift[] {
  const drifts: CodegenDrift[] = []
  for (const artifact of artifacts) {
    const drift = diffArtifact(artifact)
    if (drift) drifts.push(drift)
  }
  return drifts
}

/**
 * The lines a human reads when the check fails: which file, which line, what
 * the two sides say there.
 *
 * Long lines are truncated because a JSON manifest line or an inferred JSON
 * type can be hundreds of characters, and a wrapped wall of text hides the one
 * word that actually changed.
 */
export function describeDrift(drift: CodegenDrift): string[] {
  if (drift.reason === 'missing') {
    return [
      `${drift.path} has not been generated yet.`,
      `  Run the same command without --check to write ${drift.expectedLineCount} lines.`,
    ]
  }

  const lines = [`${drift.path} is out of date (first difference on line ${drift.line}).`]
  lines.push(`  generated: ${renderSide(drift.expectedLine)}`)
  lines.push(`  on disk:   ${renderSide(drift.actualLine)}`)
  if (drift.actualLineCount !== null && drift.actualLineCount !== drift.expectedLineCount) {
    lines.push(`  ${drift.expectedLineCount} generated lines, ${drift.actualLineCount} on disk.`)
  }
  return lines
}

const MAX_SHOWN = 120

function renderSide(line: string | null): string {
  if (line === null) return '(end of file)'
  if (line.length <= MAX_SHOWN) return line
  return `${line.slice(0, MAX_SHOWN)}…`
}

/** One sentence for the top of the report, so the count is never in doubt. */
export function describeDriftSummary(drifts: readonly CodegenDrift[]): string {
  if (drifts.length === 0) return 'Generated files are up to date.'
  const noun = drifts.length === 1 ? 'file is' : 'files are'
  return `${drifts.length} generated ${noun} out of date.`
}
