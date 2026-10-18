/**
 * The A vs B section `avsb agents-md install` puts into a repository's
 * CLAUDE.md and AGENTS.md.
 *
 * Coding agents read those files before they touch anything, so this is where a
 * team teaches one what A vs B actually is: which credential goes where, which
 * commands exist, and how a flag is read. Without it an agent invents flag keys,
 * pastes a personal access token into browser code, and writes evaluation calls
 * against an API that does not exist.
 *
 * The section is marker-delimited so re-running the command REPLACES it rather
 * than appending a second copy, and so everything the team wrote around it
 * survives byte for byte. The markers are HTML comments: invisible in rendered
 * markdown, stable across editors.
 *
 * The credential names come from the product's fixed vocabulary (personal
 * access token, service token, SDK key, snippet key). Nothing here may invent a
 * fifth name.
 *
 * Pure: text in, text out.
 */

export const AGENTS_MARKER_START = '<!-- avsb:start -->'
export const AGENTS_MARKER_END = '<!-- avsb:end -->'

export type AgentsFileName = 'CLAUDE.md' | 'AGENTS.md'

export const AGENTS_FILES: readonly AgentsFileName[] = ['CLAUDE.md', 'AGENTS.md']

export interface AgentsSectionContext {
  /** Project short id, when the command was run somewhere that knows one. */
  projectShortId: number | null
  /** Environment key the local setup uses, e.g. `production`. */
  environmentKey: string | null
  /** The environment variable the app reads the SDK key from. */
  sdkKeyEnvVar: string | null
  /** Package the project installs, e.g. `@avsbhq/react`. */
  sdkPackage: string | null
}

export type AgentsWriteOutcome =
  | 'created'
  | 'replaced'
  | 'appended'
  /** A half-deleted or out-of-order marker was cleared, then the section written. */
  | 'repaired'
  | 'unchanged'

export interface AgentsApplyResult {
  outcome: AgentsWriteOutcome
  content: string
}

/**
 * The marker-wrapped section.
 *
 * Written as instructions to an agent rather than prose for a human: short
 * rules, real command names, and the two mistakes that cost the most (a secret
 * credential in client code, and a flag key that does not exist).
 */
export function renderAgentsSection(ctx: AgentsSectionContext): string {
  const project = ctx.projectShortId === null ? 'PRJ-<id>' : `PRJ-${ctx.projectShortId}`
  const environment = ctx.environmentKey ?? 'production'
  const envVar = ctx.sdkKeyEnvVar ?? 'AVSB_SDK_KEY'
  const sdkPackage = ctx.sdkPackage ?? '@avsbhq/browser'

  return [
    AGENTS_MARKER_START,
    '',
    '## A vs B (feature flags and experiments)',
    '',
    'Managed by `avsb agents-md install`. Re-run that command to update this',
    'section; edits inside the markers are replaced.',
    '',
    `This project uses A vs B. Project ${project}, environment \`${environment}\`.`,
    '',
    '### Credentials, and which is which',
    '',
    '| Credential | Looks like | Where it belongs |',
    '| --- | --- | --- |',
    '| Personal access token | `avsb_pat_...` | Your machine, for the CLI. Never in application code. |',
    '| Service token | `avsb_svc_...` | Server-side automation calling `/api/v1`. Never in browser code. |',
    '| SDK key | `sdk_<environment>_...` | Application code reading flags. Public by design. |',
    '| Snippet key | 25-character id | The web experiments tag on a site. Public by design. |',
    '',
    'The SDK key and the snippet key are public identifiers, not secrets: they can',
    'only fetch that environment\'s configuration and send events, and they can',
    'never read or change anything in the dashboard. The other two are real',
    'credentials and belong in environment variables or a secret store.',
    '',
    `This project reads its SDK key from \`${envVar}\`.`,
    '',
    '### CLI',
    '',
    'The CLI is `avsb` (`npm install -g @avsbhq/cli`). Useful commands:',
    '',
    '```bash',
    'avsb init                 # set up a project: link, write the key, example, proof',
    'avsb whoami               # which account and organization the token reaches',
    'avsb flags list --json    # every flag key in the project, machine-readable',
    'avsb flags get <key>      # one flag, with its rules per environment',
    'avsb flags create <key>   # create a flag',
    'avsb flags toggle <key> --env production   # start or stop serving it',
    'avsb codegen              # write TypeScript types for the flags',
    'avsb open flags           # open the dashboard page in a browser',
    '```',
    '',
    'Rules for using it non-interactively: pass `--json` for a parseable envelope',
    '(`{"ok":true,"command":...,"data":...}`), and read the exit code rather than',
    'the text. 0 success, 1 ran and failed, 2 called wrongly, 3 credential',
    'problem, 4 the resource changed under you.',
    '',
    '### Reading a flag',
    '',
    `Install \`${sdkPackage}\` and pass the SDK key from \`${envVar}\`. Every getter`,
    'returns a `Flag` object, so read `.value` or call `.isEnabled()`; the object',
    'itself is not the value. Always pass a fallback: it is what serves before the',
    'configuration arrives, and `flag.source` says which case you are in.',
    '',
    'In the React, Next, Vue, Svelte, Solid and Angular packages, READING a flag',
    'records nothing. The exposure helper (`useExposure`, `createExposure`,',
    '`getExposure`, `avsbExposure`) is what records that a visitor saw the',
    'decision, so put it where the variation is actually shown.',
    '',
    '### Rules for agents working in this repository',
    '',
    '1. Never invent a flag key. List the real ones with `avsb flags list --json`,',
    '   and create one with `avsb flags create <key>` before referencing it.',
    '2. Never put a personal access token or a service token in application code,',
    '   in a browser bundle, or in a committed file.',
    '3. Never delete a flag from the dashboard to "clean up" code. Removing the',
    '   last reference in code is a separate step from removing the flag.',
    '4. Prefer generated types: `avsb codegen` writes the flag keys and value',
    '   types, so a typo becomes a compile error instead of a silent fallback.',
    '5. When a flag is behind an experiment, changing its rules changes what real',
    '   visitors see. Ask before toggling anything in `production`.',
    '',
    AGENTS_MARKER_END,
    '',
  ].join('\n')
}

/**
 * Put the section into a file's contents.
 *
 * Replaces an existing marked block in place (so the section keeps its position
 * in the file), appends when there is none, and creates the whole file when
 * there is nothing yet. Identical content is left alone so a re-run is a no-op.
 *
 * The fourth case is a file whose markers are damaged: someone deleted the end
 * marker, or an edit left the two out of order. Appending under a stray START
 * marker would add another copy on every run, because each run reads the orphan
 * as the beginning of a block whose end it cannot find. So the stray marker
 * LINES are removed first and the section appended to what is left: every word
 * the team wrote survives, and the file is well-formed for next time.
 */
export function applyAgentsSection(existing: string | null, section: string): AgentsApplyResult {
  if (existing === null) {
    return { outcome: 'created', content: section }
  }

  const start = existing.indexOf(AGENTS_MARKER_START)
  const end = existing.indexOf(AGENTS_MARKER_END)

  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start)
    const after = existing.slice(end + AGENTS_MARKER_END.length)
    const trimmedAfter = after.startsWith('\n') ? after.slice(1) : after
    const content = `${before}${section}${trimmedAfter}`
    return content === existing
      ? { outcome: 'unchanged', content: existing }
      : { outcome: 'replaced', content }
  }

  const damaged = start !== -1 || end !== -1
  const base = damaged ? stripMarkerLines(existing) : existing
  const separator = base.length === 0 ? '' : base.endsWith('\n') ? '\n' : '\n\n'

  return {
    outcome: damaged ? 'repaired' : 'appended',
    content: `${base}${separator}${section}`,
  }
}

/** Drop lines that are nothing but a marker, keeping everything else. */
function stripMarkerLines(content: string): string {
  const kept = content
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return trimmed !== AGENTS_MARKER_START && trimmed !== AGENTS_MARKER_END
    })
    .join('\n')

  // A file that ended on a marker line now ends on a blank one; collapse the
  // run so re-running cannot grow the whitespace before the section.
  return kept.replace(/\n{3,}$/, '\n\n')
}

/** The line the CLI prints, so the outcome is never implied. */
export function describeAgentsWrite(outcome: AgentsWriteOutcome, filePath: string): string {
  switch (outcome) {
    case 'created':
      return `Created ${filePath}`
    case 'replaced':
      return `Replaced the A vs B section in ${filePath}`
    case 'appended':
      return `Added an A vs B section to ${filePath}`
    case 'repaired':
      return `Repaired a broken A vs B section in ${filePath} (a marker had been removed or moved)`
    case 'unchanged':
      return `${filePath} already had this section. Left alone.`
  }
}
