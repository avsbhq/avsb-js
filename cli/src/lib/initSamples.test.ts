import { describe, expect, it } from 'vitest'
import { detectFramework, type PackageJsonLike } from './frameworkDetect.js'
import { buildFrameworkProfile } from './frameworkProfiles.js'
import { buildSample, sdkKeyExpression } from './initSamples.js'

const SDK_KEY = 'sdk_production_ttqm0eaj4vth1krcb2xn'

function profileFor(pkg: PackageJsonLike | null) {
  return buildFrameworkProfile(detectFramework(pkg))
}

function sampleFor(pkg: PackageJsonLike | null): string | null {
  return buildSample({
    profile: profileFor(pkg),
    flagKey: 'checkout_v2',
    sdkKey: SDK_KEY,
    environmentKey: 'production',
  })
}

describe('sdkKeyExpression', () => {
  it('reads a Vite variable off import.meta.env', () => {
    const profile = profileFor({ dependencies: { react: '19.0.0' }, devDependencies: { vite: '6.0.0' } })

    expect(sdkKeyExpression(profile, SDK_KEY)).toBe('import.meta.env.VITE_AVSB_SDK_KEY as string')
  })

  it('imports a SvelteKit public variable by name', () => {
    const profile = profileFor({ dependencies: { '@sveltejs/kit': '2.0.0', svelte: '5.0.0' } })

    expect(sdkKeyExpression(profile, SDK_KEY)).toBe('PUBLIC_AVSB_SDK_KEY')
  })

  it('reads process.env on the server', () => {
    const profile = profileFor({ dependencies: { express: '4.21.0' } })

    expect(sdkKeyExpression(profile, SDK_KEY)).toBe("process.env.AVSB_SDK_KEY ?? ''")
  })

  it('falls back to the literal key where no variable exists', () => {
    const profile = profileFor({ dependencies: { '@angular/core': '21.0.0' } })

    expect(sdkKeyExpression(profile, SDK_KEY)).toBe(`'${SDK_KEY}'`)
  })
})

describe('buildSample', () => {
  it('writes the flag key into every framework sample', () => {
    const packages: Array<PackageJsonLike> = [
      { dependencies: { next: '16.0.0' } },
      { dependencies: { nuxt: '3.14.0' } },
      { dependencies: { '@angular/core': '21.0.0' } },
      { dependencies: { '@sveltejs/kit': '2.0.0', svelte: '5.0.0' } },
      { dependencies: { vue: '3.5.0' }, devDependencies: { vite: '6.0.0' } },
      { dependencies: { 'solid-js': '1.9.0' }, devDependencies: { vite: '6.0.0' } },
      { dependencies: { react: '19.0.0' }, devDependencies: { vite: '6.0.0' } },
      { dependencies: { express: '4.21.0' } },
    ]

    for (const pkg of packages) {
      const sample = sampleFor(pkg)
      expect(sample, JSON.stringify(pkg)).toContain('checkout_v2')
    }
  })

  it('imports the package the profile says to install', () => {
    expect(sampleFor({ dependencies: { next: '16.0.0' } })).toContain("from '@avsbhq/next'")
    expect(sampleFor({ dependencies: { 'solid-js': '1.9.0' } })).toContain("from '@avsbhq/solid'")
    expect(sampleFor({ dependencies: { express: '4.21.0' } })).toContain("from '@avsbhq/node'")
  })

  it('records an exposure rather than relying on the read to do it', () => {
    expect(sampleFor({ dependencies: { next: '16.0.0' } })).toContain("useExposure('checkout_v2')")
    expect(sampleFor({ dependencies: { 'solid-js': '1.9.0' } })).toContain(
      "createExposure('checkout_v2')",
    )
    expect(sampleFor({ dependencies: { '@angular/core': '21.0.0' } })).toContain('avsbExposure=')
  })

  it('never puts a bare SDK key in a file that has a variable for it', () => {
    const viteReact = sampleFor({
      dependencies: { react: '19.0.0' },
      devDependencies: { vite: '6.0.0' },
    })

    expect(viteReact).toContain('import.meta.env.VITE_AVSB_SDK_KEY')
    expect(viteReact).not.toContain(SDK_KEY)
  })

  it('writes nothing for a site with no package.json, which installs the snippet instead', () => {
    expect(sampleFor(null)).toBeNull()
  })

  it('names the environment it was generated for, so a stale file is obvious', () => {
    expect(sampleFor({ dependencies: { next: '16.0.0' } })).toContain('Environment: production')
  })
})

// QA N4-17: the variable follows the bundler, and a CRA app reads it the way
// CRA inlines it.
describe('the SDK key variable follows the bundler', () => {
  it.each([
    [{ dependencies: { react: '19.0.0' }, devDependencies: { vite: '6.0.0' } }, 'VITE_AVSB_SDK_KEY', 'import.meta.env.VITE_AVSB_SDK_KEY as string'],
    [{ dependencies: { react: '19.0.0', 'react-scripts': '5.0.1' } }, 'REACT_APP_AVSB_SDK_KEY', "process.env.REACT_APP_AVSB_SDK_KEY ?? ''"],
    [{ dependencies: { vue: '3.5.0' }, devDependencies: { '@vue/cli-service': '5.0.8' } }, 'VUE_APP_AVSB_SDK_KEY', "process.env.VUE_APP_AVSB_SDK_KEY ?? ''"],
  ])('%o writes %s and reads it as %s', (pkg, envVar, expression) => {
    const profile = profileFor(pkg)

    expect(profile.envVar).toBe(envVar)
    expect(profile.envFile).toBe('.env.local')
    expect(profile.caveat).toBeNull()
    expect(profile.envVarReason).toContain('only exposes')
    expect(sdkKeyExpression(profile, SDK_KEY)).toBe(expression)
  })

  it('writes the plain name with a caveat when no known bundler is there', () => {
    const profile = profileFor({ dependencies: { 'solid-js': '1.9.0' } })

    expect(profile.envVar).toBe('AVSB_SDK_KEY')
    expect(profile.envVarReason).toBeNull()
    expect(profile.caveat).toContain('Rename AVSB_SDK_KEY')
  })

  it('does not apply Create React App to a Vue app or Vue CLI to a React app', () => {
    expect(profileFor({ dependencies: { vue: '3.5.0', 'react-scripts': '5.0.1' } }).envVar).toBe('AVSB_SDK_KEY')
    expect(profileFor({ dependencies: { react: '19.0.0', '@vue/cli-service': '5.0.8' } }).envVar).toBe('AVSB_SDK_KEY')
  })
})
