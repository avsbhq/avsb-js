/**
 * The example evaluation `avsb init` writes into the developer's project.
 *
 * One file, framework-shaped, that reads a real flag with a real key. It exists
 * so the first run ends with running code rather than a documentation link, and
 * so the heartbeat the CLI then waits for has something to arrive from.
 *
 * Every snippet mirrors the matching package's own README quickstart, including
 * the exposure rule the framework packages share: reading a flag records
 * nothing, and the exposure helper is what says the visitor saw the decision.
 * If a signature here and a README disagree, the README is right and this file
 * is the bug.
 *
 * Pure: text in, text out, no filesystem.
 */

import type { FrameworkProfile } from './frameworkProfiles.js'

export interface SampleInput {
  profile: FrameworkProfile
  /** The flag the example reads. */
  flagKey: string
  /** The environment's SDK key. Used inline only where no variable exists. */
  sdkKey: string
  /** Environment key, for the header comment. */
  environmentKey: string
}

/** How the sample reaches the SDK key, given the profile's variable choice. */
export function sdkKeyExpression(profile: FrameworkProfile, sdkKey: string): string {
  if (!profile.envVar) return `'${sdkKey}'`
  if (profile.envVar.startsWith('VITE_')) {
    return `import.meta.env.${profile.envVar} as string`
  }
  if (profile.envVar.startsWith('PUBLIC_')) return profile.envVar
  return `process.env.${profile.envVar} ?? ''`
}

function header(input: SampleInput, extra: string[]): string {
  const lines = [
    'Written by `avsb init`. Delete it once your own code reads the flag.',
    '',
    `Flag: ${input.flagKey}`,
    `Environment: ${input.environmentKey}`,
    ...extra,
  ]
  return lines.map((line) => (line.length > 0 ? `// ${line}` : '//')).join('\n')
}

function htmlComment(input: SampleInput, extra: string[]): string {
  const lines = [
    'Written by `avsb init`. Delete it once your own code reads the flag.',
    '',
    `Flag: ${input.flagKey}`,
    `Environment: ${input.environmentKey}`,
    ...extra,
  ]
  return ['<!--', ...lines.map((line) => `  ${line}`), '-->'].join('\n')
}

/**
 * The example file's contents, or null when the framework has no SDK path
 * (a site with no package.json installs the web snippet instead).
 */
export function buildSample(input: SampleInput): string | null {
  switch (input.profile.id) {
    case 'next':
      return nextSample(input)
    case 'nuxt':
      return nuxtSample(input)
    case 'angular':
      return angularSample(input)
    case 'svelte':
      return svelteSample(input)
    case 'vue':
      return vueSample(input)
    case 'solid':
      return solidSample(input)
    case 'react':
      return reactSample(input)
    case 'node':
      return nodeSample(input)
    case 'none':
      return null
  }
}

function nextSample(input: SampleInput): string {
  return `${header(input, [
    'Wrap your tree once in app/layout.tsx:',
    '',
    "  import { AvsbRoot } from '@avsbhq/next/server'",
    '  <AvsbRoot>{children}</AvsbRoot>',
    '',
    `AvsbRoot reads ${input.profile.envVar} from your environment, evaluates on the`,
    'server, and hands the client provider a datafile it already has.',
  ])}
'use client'

import { useBoolFlag, useExposure } from '@avsbhq/next'
import type { Flag } from '@avsbhq/next'

export function AvsbExample() {
  const flag: Flag<boolean> = useBoolFlag('${input.flagKey}', false)

  // Reading a flag records nothing. This is what says the visitor saw it.
  useExposure('${input.flagKey}')

  return <p>{flag.isEnabled() ? 'on' : 'off'}</p>
}
`
}

function reactSample(input: SampleInput): string {
  return `${header(input, [
    'Render <AvsbExample /> anywhere. In a real app the provider goes once at the',
    'root instead, and the components below just read the flag.',
  ])}
import { AvsbProvider, useBoolFlag, useExposure } from '@avsbhq/react'
import type { Flag } from '@avsbhq/react'

export function AvsbExample() {
  return (
    <AvsbProvider
      sdkKey={${sdkKeyExpression(input.profile, input.sdkKey)}}
      context={{ kind: 'user', key: 'user_123' }}
    >
      <FlagReadout />
    </AvsbProvider>
  )
}

function FlagReadout() {
  const flag: Flag<boolean> = useBoolFlag('${input.flagKey}', false)

  // Reading a flag records nothing. This is what says the visitor saw it.
  useExposure('${input.flagKey}')

  return <p>{flag.isEnabled() ? 'on' : 'off'}</p>
}
`
}

function solidSample(input: SampleInput): string {
  return `${header(input, [
    'Render <AvsbExample /> anywhere. In a real app the provider goes once at the',
    'root instead, and the components below just read the flag.',
  ])}
import { AvsbProvider, createBoolFlag, createExposure } from '@avsbhq/solid'
import type { JSX } from 'solid-js'

export function AvsbExample(): JSX.Element {
  return (
    <AvsbProvider
      sdkKey={${sdkKeyExpression(input.profile, input.sdkKey)}}
      context={{ kind: 'user', key: 'user_123' }}
    >
      <FlagReadout />
    </AvsbProvider>
  )
}

function FlagReadout(): JSX.Element {
  const flag = createBoolFlag('${input.flagKey}', false)

  // Reading a flag records nothing. This is what says the visitor saw it.
  createExposure('${input.flagKey}')

  return <p>{flag().isEnabled() ? 'on' : 'off'}</p>
}
`
}

function vueSample(input: SampleInput): string {
  return `${htmlComment(input, [
    'Mount AvsbProvider once at your root and render this component inside it.',
    "Import AvsbProvider from @avsbhq/vue. In that root component's script,",
    'declare the key:',
    '',
    `  const sdkKey: string = ${sdkKeyExpression(input.profile, input.sdkKey)}`,
    '',
    'then bind it in the template as :sdk-key="sdkKey" alongside',
    ':context="{ kind: \'user\', key: \'user_123\' }". The declaration and its cast',
    'belong in the script, not in a template binding.',
    '',
    'The composables below read from that provider, so they only work inside it.',
  ])}
<script setup lang="ts">
import { useBoolFlag, useExposure } from '@avsbhq/vue'

// Keep the ref: reading .value here instead would freeze the first value.
const flag = useBoolFlag('${input.flagKey}', false)

// Reading a flag records nothing. This is what says the visitor saw it.
useExposure('${input.flagKey}')
</script>

<template>
  <!-- The template unwraps the ref, so this is the Flag object itself. -->
  <p>{{ flag.isEnabled() ? 'on' : 'off' }}</p>
</template>
`
}

function nuxtSample(input: SampleInput): string {
  return `${htmlComment(input, [
    'Add "@avsbhq/nuxt" to the modules array in nuxt.config.ts, then drop',
    '<AvsbExample /> into any page. The module auto-imports the composables and',
    `reads ${input.profile.envVar} for you, so there is no provider to mount.`,
  ])}
<script setup lang="ts">
// No import line: the module auto-imports these.
const flag = useBoolFlag('${input.flagKey}', false)

// Reading a flag records nothing. This is what says the visitor saw it.
useExposure('${input.flagKey}')
</script>

<template>
  <!-- The template unwraps the ref, so this is the Flag object itself. -->
  <p>{{ flag.isEnabled() ? 'on' : 'off' }}</p>
</template>
`
}

function svelteSample(input: SampleInput): string {
  const keyExpression = sdkKeyExpression(input.profile, input.sdkKey)
  const keySource =
    input.profile.envVar === 'PUBLIC_AVSB_SDK_KEY'
      ? `PUBLIC_AVSB_SDK_KEY from $env/static/public`
      : keyExpression

  return `${htmlComment(input, [
    'Mount the provider once in your root layout and render this component',
    'inside it. Import AvsbProvider from @avsbhq/svelte/AvsbProvider.svelte,',
    `pass sdkKey (${keySource}) and`,
    "context={{ kind: 'user', key: 'user_123' }}, and render children inside it.",
    'The flag stores below read from that provider, so they only work inside it.',
  ])}
<script lang="ts">
  import { boolFlag, getExposure } from '@avsbhq/svelte'
  import { onMount } from 'svelte'

  const flag = boolFlag('${input.flagKey}', false)
  const expose = getExposure()

  // Reading a flag records nothing. This is what says the visitor saw it.
  onMount(() => expose('${input.flagKey}'))
</script>

<p>{$flag.isEnabled() ? 'on' : 'off'}</p>
`
}

function angularSample(input: SampleInput): string {
  return `${header(input, [
    'Register the client once at bootstrap:',
    '',
    "  import { provideAvsb } from '@avsbhq/angular'",
    `  provideAvsb({ sdkKey: '${input.sdkKey}', context: { kind: 'user', key: 'user_123' } })`,
    '',
    'Angular has no environment-file convention, so the key sits inline here.',
    'Move it into src/environments/environment.ts if you keep one per build.',
    'An SDK key is a public identifier, so shipping it in the bundle is expected.',
  ])}
import { Component } from '@angular/core'
import { avsbBoolFlagSignal, AVSB_TEMPLATE_FEATURES } from '@avsbhq/angular'
import type { Flag } from '@avsbhq/angular'
import type { Signal } from '@angular/core'

@Component({
  selector: 'app-avsb-example',
  standalone: true,
  imports: [AVSB_TEMPLATE_FEATURES],
  // Reading a flag records nothing. avsbExposure is what says the visitor
  // saw the decision.
  template: \`
    @if (flag().isEnabled()) {
      <p avsbExposure="${input.flagKey}">on</p>
    } @else {
      <p>off</p>
    }
  \`,
})
export class AvsbExampleComponent {
  readonly flag: Signal<Flag<boolean>> = avsbBoolFlagSignal('${input.flagKey}', false)
}
`
}

/**
 * The `console` calls below are inside the generated file, not in the CLI: a
 * server-side example that evaluates a flag and prints nothing teaches nothing.
 * The CLI's own output goes through `lib/logger.ts` as everywhere else.
 */
function nodeSample(input: SampleInput): string {
  return `${header(input, [
    'Run it with your environment file loaded, for example:',
    '',
    '  node --env-file=.env avsb-example.ts',
    '',
    'Construct AvsbServer once at boot, not per request.',
  ])}
import { AvsbServer } from '@avsbhq/node'

const server = new AvsbServer({ sdkKey: ${sdkKeyExpression(input.profile, input.sdkKey)} })

const result = await server.onReady()
if (!result.success) {
  // Flags serve the defaults you pass until a datafile arrives, and polling
  // continues in the background. Survivable, not fatal.
  console.error('AvsB init failed', result.error)
}

// Bind the context once per request.
const user = server.forUser({ kind: 'user', key: 'user_123' })
const flag = user.getBoolFlag('${input.flagKey}', false)

console.log('${input.flagKey}', flag.value, 'from', flag.source)
`
}
