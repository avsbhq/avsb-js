import { describe, expect, it } from 'vitest'
import {
  ASSISTANT_PROMPT_INTRO,
  buildAssistantPrompt,
  type AssistantPromptInput,
} from './assistantPrompt.js'

function input(overrides: Partial<AssistantPromptInput> = {}): AssistantPromptInput {
  return {
    projectType: 'FEATURE_FLAG',
    frameworkLabel: 'Next.js',
    sdkPackage: '@avsbhq/next',
    sdkKeyEnvVar: 'AVSB_SDK_KEY',
    envFile: '.env.local',
    sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
    projectShortId: 42,
    environmentKey: 'production',
    flagKey: 'checkout_v2',
    ...overrides,
  }
}

describe('buildAssistantPrompt', () => {
  it('starts with the command to run, including the project and environment', () => {
    const prompt = buildAssistantPrompt(input())

    expect(prompt).toContain('npx @avsbhq/cli init --project PRJ-42 --env production')
    expect(prompt).toContain('Next.js')
  })

  it('tells the assistant not to ask for or write down a token', () => {
    const prompt = buildAssistantPrompt(input())

    expect(prompt).toContain('saved CLI login')
    expect(prompt).toContain('do not put')
  })

  it('points at the environment file when the framework reads one', () => {
    const prompt = buildAssistantPrompt(input())

    expect(prompt).toContain('.env.local')
    expect(prompt).toContain('AVSB_SDK_KEY')
  })

  it('passes the key inline when the framework has no environment file', () => {
    const prompt = buildAssistantPrompt(
      input({ frameworkLabel: 'Angular', sdkPackage: '@avsbhq/angular', sdkKeyEnvVar: null, envFile: null }),
    )

    expect(prompt).toContain('sdk_production_ttqm0eaj4vth1krcb2xn')
    expect(prompt).not.toContain('.env.local')
  })

  it('names a real flag when there is one, and the documented placeholder when there is not', () => {
    expect(buildAssistantPrompt(input())).toContain('"checkout_v2"')
    expect(buildAssistantPrompt(input({ flagKey: null }))).toContain('"my_first_flag"')
  })

  it('says what done looks like, so the assistant can check its own work', () => {
    const prompt = buildAssistantPrompt(input())

    expect(prompt).toContain('Done looks like')
    expect(prompt).toContain('codegen')
  })

  it('switches to snippet wording for a web experiments project', () => {
    const prompt = buildAssistantPrompt(
      input({ projectType: 'WEB_EXPERIMENTATION', sdkPackage: null, sdkKey: null }),
    )

    expect(prompt).toContain('web experiments')
    expect(prompt).toContain('snippet')
    expect(prompt).not.toContain('@avsbhq/next')
  })

  it('keeps the flags story for a flags project in a folder with no package.json', () => {
    // The project type decides this, not what happens to be in the directory.
    // The old inference read "no package detected" as "web project" and handed
    // a flags customer snippet instructions.
    const prompt = buildAssistantPrompt(
      input({
        frameworkLabel: 'no framework',
        sdkPackage: null,
        sdkKeyEnvVar: null,
        envFile: null,
      }),
    )

    expect(prompt).toContain('feature flags')
    expect(prompt).not.toContain('snippet')
    expect(prompt).toContain('@avsbhq scope')
    expect(prompt).toContain('sdk_production_ttqm0eaj4vth1krcb2xn')
  })
})

describe('ASSISTANT_PROMPT_INTRO', () => {
  it('says where the block is meant to go', () => {
    expect(ASSISTANT_PROMPT_INTRO).toContain('coding assistant')
  })
})
