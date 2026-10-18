/**
 * What each detected framework needs: a package to install, an environment file
 * and variable name to write the SDK key into, and where the example file goes.
 *
 * The variable names are not invented here. Each one is the name the matching
 * package actually reads, taken from that package's own README:
 *
 *   @avsbhq/next    AVSB_SDK_KEY, then NEXT_PUBLIC_AVSB_SDK_KEY
 *   @avsbhq/nuxt    avsb.sdkKey, then NUXT_PUBLIC_AVSB_SDK_KEY, then AVSB_SDK_KEY
 *   @avsbhq/svelte  PUBLIC_AVSB_SDK_KEY through $env/static/public
 *   Vite apps       VITE_AVSB_SDK_KEY through import.meta.env
 *   Create React App  REACT_APP_AVSB_SDK_KEY through process.env
 *   Vue CLI         VUE_APP_AVSB_SDK_KEY through process.env
 *   @avsbhq/node    AVSB_SDK_KEY through process.env
 *
 * For React, Vue, Solid and plain Svelte the BUNDLER decides the name, because
 * the bundler decides which variables reach browser code. The variable used to
 * depend on Vite alone, so a Create React App project got `AVSB_SDK_KEY`, a name
 * its bundler never exposes (QA N4-17). The profile now names the bundler it
 * found and why the variable follows from it.
 *
 * Two honest gaps, both surfaced to the developer rather than papered over:
 *
 *   - Angular has no environment-file convention (its own README configures the
 *     key inline at bootstrap), so no file is written and the example carries
 *     the key with a pointer to `environments/environment.ts`.
 *   - A browser app with none of the bundlers above could be built by anything,
 *     and each tool exposes browser variables under its own prefix. The plain
 *     name is written and the caller is told to add the prefix their bundler
 *     wants.
 *
 * The SDK key is a public identifier, not a secret, so nothing here treats it
 * as one. It is written to an environment file because that is where a key that
 * changes per environment belongs, not because it needs hiding.
 */

import type { BundlerId, FrameworkDetection, FrameworkId } from './frameworkDetect.js'

export interface FrameworkProfile {
  id: FrameworkId
  /** How the CLI names it in output. */
  label: string
  /** The package `avsb init` offers to install, or null for the snippet path. */
  sdkPackage: string | null
  /** Environment file to write, relative to the project root. Null when the
   *  framework has no such convention. */
  envFile: string | null
  /** Variable name inside that file. Null alongside a null `envFile`. */
  envVar: string | null
  /** Where the example evaluation lands, relative to the project root. */
  exampleFile: string
  /** One line about anything the developer still has to decide. */
  caveat: string | null
  /**
   * Why the variable has its name, when a bundler decided it, for example
   * `Create React App only exposes REACT_APP_ variables to the browser`.
   */
  envVarReason: string | null
  /** Documentation path for this framework's full setup. */
  docsPath: string
}

const BROWSER_ENV_FILE = '.env.local'

const UNPREFIXED_CAVEAT =
  'No Vite, Create React App or Vue CLI in this project, so the browser variable prefix is your bundler\'s call. Rename AVSB_SDK_KEY to the prefix your bundler exposes to the browser, or pass the key to the provider directly.'

interface BrowserVariable {
  envVar: string
  envVarReason: string | null
  caveat: string | null
}

const BUNDLER_VARIABLES: Record<BundlerId, { envVar: string; label: string; prefix: string }> = {
  vite: { envVar: 'VITE_AVSB_SDK_KEY', label: 'Vite', prefix: 'VITE_' },
  'create-react-app': { envVar: 'REACT_APP_AVSB_SDK_KEY', label: 'Create React App', prefix: 'REACT_APP_' },
  'vue-cli': { envVar: 'VUE_APP_AVSB_SDK_KEY', label: 'Vue CLI', prefix: 'VUE_APP_' },
}

/**
 * The browser variable for a front-end framework, from the bundler that builds
 * it. Create React App only builds React and Vue CLI only builds Vue, so those
 * two are honoured only for their own framework.
 */
export function browserVariable(detection: FrameworkDetection): BrowserVariable {
  const bundler = detection.bundler
  const applies =
    bundler !== null &&
    (bundler.id === 'vite' ||
      (bundler.id === 'create-react-app' && detection.id === 'react') ||
      (bundler.id === 'vue-cli' && detection.id === 'vue'))
  if (!applies || bundler === null) {
    return { envVar: 'AVSB_SDK_KEY', envVarReason: null, caveat: UNPREFIXED_CAVEAT }
  }
  const known = BUNDLER_VARIABLES[bundler.id]
  return {
    envVar: known.envVar,
    envVarReason: `found ${bundler.dependency}, and ${known.label} only exposes ${known.prefix} variables to the browser`,
    caveat: null,
  }
}

/**
 * The profile for a detection result.
 *
 * Takes the whole detection rather than the id because the front-end frameworks
 * pick their variable name from the toolchain (Vite or SvelteKit), not from the
 * framework alone.
 */
export function buildFrameworkProfile(detection: FrameworkDetection): FrameworkProfile {
  switch (detection.id) {
    case 'next':
      return {
        id: 'next',
        label: 'Next.js',
        sdkPackage: '@avsbhq/next',
        envFile: '.env.local',
        envVar: 'AVSB_SDK_KEY',
        exampleFile: 'avsb-example.tsx',
        caveat: null,
        envVarReason: null,
        docsPath: '/docs/integrations/nextjs-app-router',
      }
    case 'nuxt':
      return {
        id: 'nuxt',
        label: 'Nuxt',
        sdkPackage: '@avsbhq/nuxt',
        envFile: '.env',
        envVar: 'NUXT_PUBLIC_AVSB_SDK_KEY',
        exampleFile: 'components/AvsbExample.vue',
        caveat: 'Add "@avsbhq/nuxt" to the modules array in nuxt.config.ts. The module reads the key from this variable.',
        envVarReason: null,
        docsPath: '/docs/integrations/nuxt',
      }
    case 'angular':
      return {
        id: 'angular',
        label: 'Angular',
        sdkPackage: '@avsbhq/angular',
        envFile: null,
        envVar: null,
        exampleFile: 'src/app/avsb-example.component.ts',
        caveat:
          'Angular reads configuration from src/environments/environment.ts rather than an environment file, so the example carries the key inline. Move it into your environment file if you keep one per build target.',
        envVarReason: null,
        docsPath: '/docs/integrations/angular-cli',
      }
    case 'svelte':
      return detection.usesSvelteKit
        ? {
            id: 'svelte',
            label: 'SvelteKit',
            sdkPackage: '@avsbhq/svelte',
            envFile: '.env',
            envVar: 'PUBLIC_AVSB_SDK_KEY',
            exampleFile: 'src/lib/AvsbExample.svelte',
            caveat: null,
            envVarReason: null,
            docsPath: '/docs/integrations/sveltekit',
          }
        : {
            id: 'svelte',
            label: 'Svelte',
            sdkPackage: '@avsbhq/svelte',
            envFile: BROWSER_ENV_FILE,
            ...browserVariable(detection),
            exampleFile: 'src/AvsbExample.svelte',
            docsPath: '/docs/integrations/vite-svelte',
          }
    case 'vue':
      return {
        id: 'vue',
        label: 'Vue',
        sdkPackage: '@avsbhq/vue',
        envFile: BROWSER_ENV_FILE,
        ...browserVariable(detection),
        exampleFile: 'src/AvsbExample.vue',
        docsPath: '/docs/integrations/vite-vue',
      }
    case 'solid':
      return {
        id: 'solid',
        label: 'Solid',
        sdkPackage: '@avsbhq/solid',
        envFile: BROWSER_ENV_FILE,
        ...browserVariable(detection),
        exampleFile: 'src/avsb-example.tsx',
        docsPath: '/docs/integrations/vite-solid',
      }
    case 'react':
      return {
        id: 'react',
        label: 'React',
        sdkPackage: '@avsbhq/react',
        envFile: BROWSER_ENV_FILE,
        ...browserVariable(detection),
        exampleFile: 'src/avsb-example.tsx',
        docsPath: '/docs/integrations/vite-react',
      }
    case 'node':
      return {
        id: 'node',
        label: 'Node.js',
        sdkPackage: '@avsbhq/node',
        envFile: '.env',
        envVar: 'AVSB_SDK_KEY',
        exampleFile: 'avsb-example.ts',
        caveat: null,
        envVarReason: null,
        docsPath: '/docs/developer-reference/avsb-node',
      }
    case 'none':
      return {
        id: 'none',
        label: 'no framework',
        sdkPackage: null,
        envFile: null,
        envVar: null,
        exampleFile: 'avsb-example.html',
        // Says nothing about which pillar this is: the PROJECT decides that, and
        // a feature flags project set up from a folder with no package.json was
        // being told it was a web experiments project.
        caveat:
          'No package.json here, so no framework was detected. Run this in your application directory to have the SDK wired up for you.',
        envVarReason: null,
        docsPath: '/docs/getting-started/installing-the-snippet',
      }
  }
}
