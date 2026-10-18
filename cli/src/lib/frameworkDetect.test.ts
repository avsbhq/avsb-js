import { describe, expect, it } from 'vitest'
import {
  detectFramework,
  detectPackageManager,
  installArgv,
  installCommand,
  isFrameworkId,
  parsePackageJson,
  type PackageJsonLike,
} from './frameworkDetect.js'

function pkg(dependencies: Record<string, string>, devDependencies: Record<string, string> = {}): PackageJsonLike {
  return { dependencies, devDependencies }
}

describe('parsePackageJson', () => {
  it('reads the dependency maps and ignores non-string versions', () => {
    const parsed = parsePackageJson(
      JSON.stringify({ name: 'app', dependencies: { react: '19.0.0', broken: 3 } }),
    )

    expect(parsed?.name).toBe('app')
    expect(parsed?.dependencies).toEqual({ react: '19.0.0' })
  })

  it('returns null for malformed JSON rather than throwing mid-setup', () => {
    expect(parsePackageJson('{ not json')).toBeNull()
  })

  it('returns null for JSON that is not an object', () => {
    expect(parsePackageJson('[1, 2, 3]')).toBeNull()
    expect(parsePackageJson('"a string"')).toBeNull()
  })
})

describe('detectFramework', () => {
  it('answers none when there is no package.json, which is the snippet path', () => {
    expect(detectFramework(null).id).toBe('none')
  })

  it('prefers the outer framework where frameworks nest', () => {
    // Every one of these projects also declares the inner framework.
    expect(detectFramework(pkg({ next: '16.0.0', react: '19.0.0' })).id).toBe('next')
    expect(detectFramework(pkg({ nuxt: '3.14.0', vue: '3.5.0' })).id).toBe('nuxt')
    expect(detectFramework(pkg({ '@sveltejs/kit': '2.0.0', svelte: '5.0.0' })).id).toBe('svelte')
  })

  it('names the dependency that decided it', () => {
    expect(detectFramework(pkg({ 'solid-js': '1.9.0' })).matchedDependency).toBe('solid-js')
    expect(detectFramework(pkg({ '@angular/core': '21.0.0' })).matchedDependency).toBe('@angular/core')
  })

  it('reads devDependencies too, because Vite lives there', () => {
    const detection = detectFramework(pkg({ react: '19.0.0' }, { vite: '6.0.0' }))

    expect(detection.id).toBe('react')
    expect(detection.usesVite).toBe(true)
  })

  it('falls through to node for a package.json with no front-end framework', () => {
    const detection = detectFramework(pkg({ express: '4.21.0' }))

    expect(detection.id).toBe('node')
    expect(detection.matchedDependency).toBeNull()
  })

  it('flags SvelteKit separately from Svelte, because the variable name differs', () => {
    expect(detectFramework(pkg({ svelte: '5.0.0' })).usesSvelteKit).toBe(false)
    expect(detectFramework(pkg({ '@sveltejs/kit': '2.0.0' })).usesSvelteKit).toBe(true)
  })
})

describe('isFrameworkId', () => {
  it('accepts every id the CLI knows and refuses anything else', () => {
    expect(isFrameworkId('next')).toBe(true)
    expect(isFrameworkId('node')).toBe(true)
    expect(isFrameworkId('ember')).toBe(false)
  })
})

describe('detectPackageManager', () => {
  it('prefers the declared packageManager field over any lockfile', () => {
    const manager = detectPackageManager({ packageManager: 'pnpm@9.12.0' }, ['package-lock.json'])

    expect(manager).toBe('pnpm')
  })

  it('falls back to the lockfile on disk', () => {
    expect(detectPackageManager(null, ['yarn.lock'])).toBe('yarn')
    expect(detectPackageManager(null, ['bun.lockb'])).toBe('bun')
    expect(detectPackageManager(null, ['pnpm-lock.yaml'])).toBe('pnpm')
  })

  it('defaults to npm when nothing says otherwise', () => {
    expect(detectPackageManager(null, [])).toBe('npm')
    expect(detectPackageManager({ packageManager: 'unknown@1' }, [])).toBe('npm')
  })
})

describe('installCommand', () => {
  it('uses each manager s own grammar', () => {
    expect(installCommand('npm', '@avsbhq/react')).toBe('npm install @avsbhq/react')
    expect(installCommand('pnpm', '@avsbhq/react')).toBe('pnpm add @avsbhq/react')
    expect(installCommand('yarn', '@avsbhq/react')).toBe('yarn add @avsbhq/react')
    expect(installCommand('bun', '@avsbhq/react')).toBe('bun add @avsbhq/react')
  })

  it('splits into argv so the package name never reaches a shell', () => {
    expect(installArgv('pnpm', '@avsbhq/node')).toEqual({
      command: 'pnpm',
      args: ['add', '@avsbhq/node'],
    })
  })
})

// QA N4-17: the browser variable followed Vite alone, so Create React App and
// Vue CLI projects got a name their bundler never exposes.
describe('detectBundler', () => {
  it('finds the bundler whose variable prefix is known, Vite first', () => {
    expect(detectFramework(pkg({ react: '19.0.0' }, { vite: '6.0.0' })).bundler).toEqual({ id: 'vite', dependency: 'vite' })
    expect(detectFramework(pkg({ react: '19.0.0', 'react-scripts': '5.0.1' })).bundler).toEqual({
      id: 'create-react-app',
      dependency: 'react-scripts',
    })
    expect(detectFramework(pkg({ vue: '3.5.0' }, { '@vue/cli-service': '5.0.8' })).bundler?.id).toBe('vue-cli')
  })

  it('answers null when no known bundler is declared', () => {
    expect(detectFramework(pkg({ react: '19.0.0', webpack: '5.0.0' })).bundler).toBeNull()
    expect(detectFramework(null).bundler).toBeNull()
  })
})
