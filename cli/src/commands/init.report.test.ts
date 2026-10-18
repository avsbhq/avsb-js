import { describe, expect, it } from 'vitest'
import { buildFrameworkProfile } from '../lib/frameworkProfiles.js'
import { describeDetection, fileReport, whatIsLeftLines, type InitSummaryInput } from './init.report.js'
import { detectFramework } from '../lib/frameworkDetect.js'

function summary(overrides: Partial<InitSummaryInput> = {}): InitSummaryInput {
  return {
    project: { shortId: 200014, name: 'QA-CLI', type: 'FEATURE_FLAG' } as InitSummaryInput['project'],
    created: true,
    environment: {
      id: 'env-1',
      key: 'production',
      name: 'Production',
      sdkKey: 'sdk_production_abc',
    } as InitSummaryInput['environment'],
    profile: buildFrameworkProfile({ id: 'node', matchedDependency: null, usesVite: false, usesSvelteKit: false, bundler: null }),
    detection: { id: 'node', matchedDependency: null, usesVite: false, usesSvelteKit: false, bundler: null },
    packageManager: 'npm',
    plan: [],
    files: { env: null, envOutcome: null, example: null, codegen: null, gitignore: null },
    install: null,
    flagKey: 'my_first_flag',
    flagExists: true,
    servedLine: null,
    heartbeat: null,
    proof: null,
    timeoutGuidance: [],
    ...overrides,
  }
}

describe('whatIsLeftLines (the "Next" list)', () => {
  it('tells a new project to create the flag and then turn it on (N4-9)', () => {
    const lines = whatIsLeftLines(summary({ flagExists: false }))

    expect(lines).toContain(
      'The example reads "my_first_flag", which does not exist yet. Create it with `avsb flags create my_first_flag`, then turn it on with `avsb flags toggle my_first_flag --env production --on`.',
    )
  })

  it('carries the line about what the environment serves', () => {
    const lines = whatIsLeftLines(summary({ servedLine: 'my_first_flag is not being served in this environment yet.' }))

    expect(lines).toEqual(['my_first_flag is not being served in this environment yet.'])
  })

  it('is empty when nothing is left to do', () => {
    expect(whatIsLeftLines(summary())).toEqual([])
  })

  it('asks to install the SDK when the install was printed, not run', () => {
    const lines = whatIsLeftLines(summary({ install: { command: 'npm install @avsbhq/node', ran: false, ok: false } }))

    expect(lines[0]).toBe('Install the SDK: npm install @avsbhq/node')
  })
})

describe('fileReport (QA N4-16)', () => {
  const files = {
    env: '/app/.env.local',
    envOutcome: null,
    example: null,
    codegen: null,
    gitignore: null,
  } as const

  it('lists the environment file as written when this run created or appended it', () => {
    expect(fileReport({ ...files, envOutcome: 'created' })).toEqual({ written: ['/app/.env.local'], leftAlone: [] })
    expect(fileReport({ ...files, envOutcome: 'appended' }).written).toEqual(['/app/.env.local'])
  })

  it('lists it as left alone on a second run, never as written', () => {
    expect(fileReport({ ...files, envOutcome: 'unchanged' })).toEqual({ written: [], leftAlone: ['/app/.env.local'] })
    expect(fileReport({ ...files, envOutcome: 'conflict' })).toEqual({ written: [], leftAlone: ['/app/.env.local'] })
  })

  it('reports the .gitignore it added the file to as written', () => {
    expect(fileReport({ ...files, envOutcome: 'created', gitignore: '/app/.gitignore' }).written).toEqual([
      '/app/.env.local',
      '/app/.gitignore',
    ])
  })
})

describe('describeDetection says why the variable has its name (QA N4-17)', () => {
  it('names the bundler that decided the prefix', () => {
    const detection = detectFramework({ dependencies: { react: '19.0.0', 'react-scripts': '5.0.1' } })

    expect(describeDetection({ detection, profile: buildFrameworkProfile(detection), packageManager: 'npm' })).toBe(
      'React (found react in package.json, key in REACT_APP_AVSB_SDK_KEY: found react-scripts, and Create React App only exposes REACT_APP_ variables to the browser, installs with npm)',
    )
  })

  it('adds nothing for a framework whose variable is fixed', () => {
    const detection = detectFramework({ dependencies: { next: '16.0.0', react: '19.0.0' } })

    expect(describeDetection({ detection, profile: buildFrameworkProfile(detection), packageManager: 'pnpm' })).toBe(
      'Next.js (found next in package.json, installs with pnpm)',
    )
  })
})
