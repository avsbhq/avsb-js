/**
 * The paste-one-prompt block: what a developer hands to their coding assistant
 * so the assistant finishes the setup instead of guessing at it.
 *
 * The prompt names the command to run, the key facts it cannot infer (project,
 * environment, package, variable name), and the outcome to check. It never
 * embeds a credential the assistant should not see: an SDK key is a public
 * identifier, so it is fine in the prompt; a personal access token is not, and
 * the prompt tells the assistant to use the developer's saved login instead.
 *
 * The dashboard renders its own version of this block from the same facts (see
 * the onboarding install step); the two are separate because neither surface
 * can import the other, and they say the same thing.
 *
 * Pure: facts in, text out.
 */

export interface AssistantPromptInput {
  /**
   * Which pillar this project is. THE branch: a web experiments project
   * installs a tag, a feature flags project installs a package. It is decided
   * by the project, never inferred from what is in the directory, so a flags
   * project set up from a folder with no package.json still gets flag
   * instructions.
   */
  projectType: 'WEB_EXPERIMENTATION' | 'FEATURE_FLAG'
  /** Human label, e.g. `Next.js`. Used in the first line so the assistant
   *  knows what it is looking at. */
  frameworkLabel: string
  /** Package the project installs, or null on the web-snippet path. */
  sdkPackage: string | null
  /** Environment variable the app reads the key from, when there is one. */
  sdkKeyEnvVar: string | null
  /** Environment file that variable lives in, when there is one. */
  envFile: string | null
  /** Public SDK key for the chosen environment, or null on the snippet path. */
  sdkKey: string | null
  projectShortId: number
  environmentKey: string
  /** A real flag key to read, when the project has one. */
  flagKey: string | null
}

/**
 * The prompt for a feature-flag setup. Written as instructions to an assistant:
 * numbered, checkable, and ending in what "done" looks like.
 */
export function buildAssistantPrompt(input: AssistantPromptInput): string {
  const flagKey = input.flagKey ?? 'my_first_flag'

  if (input.projectType !== 'FEATURE_FLAG') {
    return [
      'Set up A vs B web experiments in this project.',
      '',
      `1. Run: npx @avsbhq/cli init --project PRJ-${input.projectShortId}`,
      '   It uses my saved CLI login, so do not ask me for a token and do not put',
      '   one in any file.',
      '2. Follow what it prints. A web experiments project installs the A vs B',
      '   snippet tag in the site HTML rather than an npm package.',
      '3. Done looks like: the dashboard install panel says Installed, which',
      '   happens the first time a page with the tag is loaded.',
    ].join('\n')
  }

  const lines = [
    `Set up A vs B feature flags in this ${input.frameworkLabel} project.`,
    '',
    `1. Run: npx @avsbhq/cli init --project PRJ-${input.projectShortId} --env ${input.environmentKey}`,
    '   It uses my saved CLI login, so do not ask me for a token and do not put',
    '   one in any file. It detects the framework, writes the SDK key, and writes',
    '   an example file.',
    // No package name when nothing was detected here: naming one would be a
    // guess, and the assistant can see which framework the app really uses.
    input.sdkPackage
      ? `2. Install ${input.sdkPackage} with this project's package manager.`
      : "2. Install the A vs B SDK for this app's framework from the @avsbhq scope\n   (@avsbhq/react, @avsbhq/next, @avsbhq/vue, @avsbhq/svelte, @avsbhq/solid,\n   @avsbhq/nuxt, @avsbhq/angular or @avsbhq/node).",
  ]

  if (input.sdkKeyEnvVar && input.envFile) {
    lines.push(
      `3. Wire the app up: the SDK key is in ${input.envFile} as ${input.sdkKeyEnvVar}.`,
      `   Mount the provider once at the root, reading ${input.sdkKeyEnvVar}, and`,
      `   read the flag "${flagKey}" in one component.`,
    )
  } else {
    lines.push(
      `3. Wire the app up: pass the SDK key ${input.sdkKey ?? '(shown by avsb init)'} where`,
      `   the client is created, and read the flag "${flagKey}" in one component.`,
    )
  }

  lines.push(
    '4. Every getter returns a Flag object, so read .value or call .isEnabled().',
    '   Reading a flag records nothing: call the package\'s exposure helper where',
    '   the variation is shown.',
    '5. Then run: npx @avsbhq/cli codegen',
    '   so the flag keys and value types are typed instead of strings.',
    '',
    'Done looks like: the app starts, the flag reads without throwing, and the A',
    'vs B dashboard shows the environment as Installed.',
  )

  return lines.join('\n')
}

/** The one line printed above the block, so it is obvious what to do with it. */
export const ASSISTANT_PROMPT_INTRO =
  'Paste this into your coding assistant (Claude Code, Cursor, Copilot) to finish the wiring:'
