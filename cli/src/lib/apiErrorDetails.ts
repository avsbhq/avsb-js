/**
 * The reasons inside a refusal, for humans.
 *
 * A validation failure carries the useful part in `details`: which field, and
 * why. `--json` always printed it; human mode printed only "Request body failed
 * validation" plus a docs link, so the reason was one flag away from anyone who
 * did not know to ask (QA N4-11). These lines are printed under the message in
 * every mode.
 *
 * Two shapes are read, both defensively, since they arrive as untyped JSON:
 *
 *   details.issues            [{ param, path, message }]   a field failed validation
 *   details.compilationErrors [{ file, line, column, message, path? }]   code that does not compile
 *
 * A command that knows what a request-body path means locally (`avsb push`
 * knows `variations.0.controlJs` is `control/control.js`) passes a labeller,
 * so the line names the file on disk instead of the JSON path.
 */

/** Names the local thing a request-body path refers to, when the command knows it. */
export type PathLabeller = (path: ReadonlyArray<string | number>) => string | undefined

export interface ValidationIssueLine {
  path: Array<string | number>
  param: string
  message: string
}

export interface CompilationErrorLine {
  file: string
  line: number
  column: number
  message: string
  path?: Array<string | number>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPath(value: unknown): Array<string | number> | undefined {
  if (!Array.isArray(value)) return undefined
  const path = value.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')
  return path.length === value.length ? path : undefined
}

/** `details.issues`, keeping only entries that carry a message. */
export function readValidationIssues(details: Record<string, unknown> | undefined): ValidationIssueLine[] {
  const raw = details?.issues
  if (!Array.isArray(raw)) return []
  const issues: ValidationIssueLine[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.message !== 'string') continue
    const path = readPath(entry.path) ?? []
    const param = typeof entry.param === 'string' ? entry.param : path.join('.')
    issues.push({ path, param, message: entry.message })
  }
  return issues
}

/** `details.compilationErrors`, keeping only entries that name a file and a message. */
export function readCompilationErrors(details: Record<string, unknown> | undefined): CompilationErrorLine[] {
  const raw = details?.compilationErrors
  if (!Array.isArray(raw)) return []
  const errors: CompilationErrorLine[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.file !== 'string' || typeof entry.message !== 'string') continue
    const path = readPath(entry.path)
    errors.push({
      file: entry.file,
      line: typeof entry.line === 'number' ? entry.line : 0,
      column: typeof entry.column === 'number' ? entry.column : 0,
      message: entry.message,
      ...(path ? { path } : {}),
    })
  }
  return errors
}

/** `file:line:col` when the position is known, the file alone when it is not. */
function position(file: string, line: number, column: number): string {
  if (line <= 0) return file
  return column > 0 ? `${file}:${line}:${column}` : `${file}:${line}`
}

/**
 * One line per reason. A labelled issue reads `control/control.js
 * (variations.0.controlJs.compiled): Required`, so both the file and the key
 * are named; an unlabelled one reads `key: Key must be lowercase…`.
 */
export function describeErrorDetails(
  details: Record<string, unknown> | undefined,
  labelForPath?: PathLabeller,
): string[] {
  const lines: string[] = []

  for (const issue of readValidationIssues(details)) {
    const label = issue.path.length > 0 ? labelForPath?.(issue.path) : undefined
    const where = label ? `${label} (${issue.param})` : issue.param || '(request body)'
    lines.push(`${where}: ${issue.message}`)
  }

  for (const error of readCompilationErrors(details)) {
    const label = error.path ? labelForPath?.(error.path) : undefined
    lines.push(`${position(label ?? error.file, error.line, error.column)}: ${error.message}`)
  }

  return lines
}
