import { describe, expect, it } from 'vitest'
import { CliError } from './cliError.js'
import { detectFramework } from './frameworkDetect.js'
import { buildFrameworkProfile } from './frameworkProfiles.js'
import {
  assertHeartbeatFlagsAgree,
  buildProofLine,
  describeServedValue,
  formatElapsed,
  parseWaitSeconds,
  planInitSteps,
  servedValueFor,
  stepFor,
  type InitPlanInput,
  type InitStepId,
} from './initPlan.js'

const reactProfile = buildFrameworkProfile(
  detectFramework({ dependencies: { react: '19.0.0' }, devDependencies: { vite: '6.0.0' } }),
)
const angularProfile = buildFrameworkProfile(
  detectFramework({ dependencies: { '@angular/core': '21.0.0' } }),
)
const siteProfile = buildFrameworkProfile(detectFramework(null))

function input(overrides: Partial<InitPlanInput> = {}): InitPlanInput {
  return {
    profile: reactProfile,
    packageManager: 'npm',
    projectType: 'FEATURE_FLAG',
    sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
    exampleExists: false,
    options: { env: true, install: false, example: true, codegen: false, wait: true },
    ...overrides,
  }
}

function actionFor(plan: ReturnType<typeof planInitSteps>, id: InitStepId): string {
  return stepFor(plan, id).action
}

describe('planInitSteps', () => {
  it('plans the whole run for a detected framework with a key in hand', () => {
    const plan = planInitSteps(input())

    expect(plan.map((step) => step.id)).toEqual([
      'env',
      'install',
      'example',
      'codegen',
      'heartbeat',
    ])
    expect(actionFor(plan, 'env')).toBe('write')
    expect(actionFor(plan, 'install')).toBe('print')
    expect(actionFor(plan, 'example')).toBe('write')
    expect(actionFor(plan, 'heartbeat')).toBe('wait')
  })

  it('runs the install only when asked, and names the detected manager either way', () => {
    const printed = stepFor(planInitSteps(input({ packageManager: 'pnpm' })), 'install')
    const executed = stepFor(
      planInitSteps(
        input({
          packageManager: 'pnpm',
          options: { env: true, install: true, example: true, codegen: false, wait: true },
        }),
      ),
      'install',
    )

    expect(printed.action).toBe('print')
    expect(printed.detail).toContain('pnpm add @avsbhq/react')
    expect(executed.action).toBe('run')
    expect(executed.detail).toBe('pnpm add @avsbhq/react')
  })

  it('skips the environment file for a framework that has no such convention', () => {
    const step = stepFor(planInitSteps(input({ profile: angularProfile })), 'env')

    expect(step.action).toBe('skip')
    expect(step.detail).toContain('Angular')
  })

  it('never overwrites an example that is already there', () => {
    const step = stepFor(planInitSteps(input({ exampleExists: true })), 'example')

    expect(step.action).toBe('skip')
    expect(step.detail).toContain('already exists')
  })

  it('skips the SDK steps entirely for a web experiments project', () => {
    const plan = planInitSteps(
      input({ profile: siteProfile, projectType: 'WEB_EXPERIMENTATION', sdkKey: null }),
    )

    expect(actionFor(plan, 'env')).toBe('skip')
    expect(actionFor(plan, 'install')).toBe('skip')
    expect(actionFor(plan, 'example')).toBe('skip')
    expect(actionFor(plan, 'codegen')).toBe('skip')
    expect(actionFor(plan, 'heartbeat')).toBe('skip')
    expect(stepFor(plan, 'heartbeat').detail).toContain('first page view')
  })

  it('tells a flags project in a folder with no package.json the truth, not the web story', () => {
    // The project TYPE says feature flags; the DIRECTORY is what has nothing to
    // install into. Reporting this as a web experiments project would be false.
    const plan = planInitSteps(input({ profile: siteProfile, projectType: 'FEATURE_FLAG' }))

    for (const id of ['env', 'install', 'example'] as const) {
      expect(actionFor(plan, id), id).toBe('skip')
      expect(stepFor(plan, id).detail, id).toContain('No package.json here')
      expect(stepFor(plan, id).detail, id).not.toContain('web experiments')
    }
  })

  it('still waits for the check-in when the directory has no framework in it', () => {
    // The app living elsewhere does not stop the key from working, so the proof
    // step survives a directory with nothing to install into.
    const plan = planInitSteps(input({ profile: siteProfile, projectType: 'FEATURE_FLAG' }))

    expect(actionFor(plan, 'heartbeat')).toBe('wait')
  })

  it('reports a missing SDK key as exactly that, not as a project type', () => {
    const plan = planInitSteps(input({ projectType: 'FEATURE_FLAG', sdkKey: null }))

    expect(stepFor(plan, 'env').detail).toContain('No SDK key')
    expect(stepFor(plan, 'heartbeat').detail).toContain('No SDK key')
  })

  it('records which flag turned a step off, so a skipped step is never a mystery', () => {
    const plan = planInitSteps(
      input({ options: { env: false, install: false, example: false, codegen: false, wait: false } }),
    )

    expect(stepFor(plan, 'env').detail).toContain('--no-env-file')
    expect(stepFor(plan, 'example').detail).toContain('--no-example')
    expect(stepFor(plan, 'heartbeat').detail).toContain('--no-wait')
    expect(stepFor(plan, 'codegen').detail).toContain('--codegen')
  })
})

describe('parseWaitSeconds', () => {
  it('takes the documented default when the flag was not given a value', () => {
    expect(parseWaitSeconds(true)).toBe(120)
    expect(parseWaitSeconds(undefined)).toBe(120)
  })

  it('reads a number of seconds and caps a wildly long wait', () => {
    expect(parseWaitSeconds('90')).toBe(90)
    expect(parseWaitSeconds(' 45 ')).toBe(45)
    expect(parseWaitSeconds('99999')).toBe(900)
  })

  it('refuses nonsense as a usage error rather than waiting silently', () => {
    expect(() => parseWaitSeconds('soon')).toThrow(CliError)
    expect(() => parseWaitSeconds('-5')).toThrow(CliError)
  })
})

describe('servedValueFor', () => {
  const variations = [
    { id: 'var_on', key: 'on', value: true },
    { id: 'var_off', key: 'off', value: false },
  ]

  it('reports the default variation the environment serves', () => {
    expect(
      servedValueFor({ enabled: true, defaultVariationId: 'var_on', variations }),
    ).toEqual({ variationKey: 'on', value: true })
  })

  it('reports nothing when the environment is not serving the flag', () => {
    expect(servedValueFor({ enabled: false, defaultVariationId: 'var_on', variations })).toBeNull()
  })

  it('reports nothing when the default variation is missing from the datafile', () => {
    expect(
      servedValueFor({ enabled: true, defaultVariationId: 'var_gone', variations }),
    ).toBeNull()
  })
})

describe('describeServedValue', () => {
  it('says what a caller gets in both cases, without claiming rules were evaluated', () => {
    const served = describeServedValue('checkout_v2', { variationKey: 'on', value: true })
    const unserved = describeServedValue('checkout_v2', null)

    expect(served).toContain('when no targeting rule matches')
    expect(served).toContain('true')
    expect(unserved).toContain('fallback')
  })

  it('names the command that turns an unserved flag on, for the environment set up (N4-9)', () => {
    expect(describeServedValue('checkout_v2', null, 'staging')).toContain(
      '`avsb flags toggle checkout_v2 --env staging --on`',
    )
    expect(describeServedValue('checkout_v2', { variationKey: 'on', value: true }, 'staging')).not.toContain('toggle')
  })
})

describe('formatElapsed', () => {
  it('reads in the unit that suits the size', () => {
    expect(formatElapsed(420)).toBe('420 ms')
    expect(formatElapsed(8213)).toBe('8s')
    expect(formatElapsed(119_400)).toBe('119s')
  })
})

describe('buildProofLine', () => {
  it('names the key, the flag, the framework and how long it took', () => {
    const line = buildProofLine({
      sdkKey: 'sdk_production_abc',
      flagKey: 'checkout_v2',
      frameworkLabel: 'Next.js',
      elapsedMs: 8213,
    })

    expect(line).toBe(
      "sdk_production_abc checked in and is serving 'checkout_v2' for Next.js 8s after setup",
    )
  })

  it('claims only what was observed, never that the CLI evaluated anything', () => {
    // The evaluation happens inside the developer's process, out of the CLI's
    // sight. The line must not say otherwise.
    const line = buildProofLine({
      sdkKey: 'sdk_production_abc',
      flagKey: 'checkout_v2',
      frameworkLabel: 'Next.js',
      elapsedMs: 900,
    })

    expect(line).toContain('checked in')
    expect(line).not.toContain('evaluated')
    expect(line).toContain('900 ms')
  })
})

describe('assertHeartbeatFlagsAgree', () => {
  it('accepts every combination that means something', () => {
    expect(() => assertHeartbeatFlagsAgree({ wait: true })).not.toThrow()
    expect(() => assertHeartbeatFlagsAgree({ wait: '90', requireHeartbeat: true })).not.toThrow()
    expect(() => assertHeartbeatFlagsAgree({ wait: false })).not.toThrow()
    expect(() =>
      assertHeartbeatFlagsAgree({ wait: true, requireHeartbeat: true }),
    ).not.toThrow()
  })

  it('refuses --require-heartbeat with --no-wait as a usage error', () => {
    try {
      assertHeartbeatFlagsAgree({ wait: false, requireHeartbeat: true })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).code).toBe('cli_usage')
      expect((err as CliError).message).toContain('--no-wait')
      expect((err as CliError).hints.join(' ')).toContain('heartbeat.seen')
    }
  })
})
