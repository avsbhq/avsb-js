import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveProjectPullTarget, updateProjectFile, writeProjectManifest } from './projectScaffold.js'
import type { ApiProjectResponse, ProjectManifest } from '../types/project.js'

let root = ''

function manifestFor(shortId: number): ProjectManifest {
  return {
    version: 1,
    projectId: `proj_${shortId}`,
    projectShortId: shortId,
    projectName: 'QA-Sandbox',
    orgId: 'org-1',
    snippetKey: 'snip_abc',
    language: 'js',
    lastSyncedAt: '2026-10-01T10:00:00.000Z',
    platformUrl: `https://app.avsb.cloud/projects/${shortId}/settings?tab=snippet`,
  }
}

function pulledFolder(dir: string, shortId: number, script = 'function initProject(o) {}\n'): void {
  fs.mkdirSync(dir, { recursive: true })
  writeProjectManifest(dir, manifestFor(shortId))
  fs.writeFileSync(path.join(dir, 'project.js'), script)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'avsb-project-pull-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('resolveProjectPullTarget (QA N4-18)', () => {
  it('re-pulls into the project folder you are standing in, never a nested copy', () => {
    const folder = path.join(root, 'project-200009')
    pulledFolder(folder, 200009)

    expect(resolveProjectPullTarget(folder, 200009)).toEqual({ kind: 'existing', dir: folder })
    expect(resolveProjectPullTarget(path.join(folder), 200009).dir).not.toContain('project-200009/project-200009')
  })

  it('finds the project folder from a subfolder of it too', () => {
    const folder = path.join(root, 'project-200009')
    pulledFolder(folder, 200009)
    const sub = path.join(folder, 'notes')
    fs.mkdirSync(sub)

    expect(resolveProjectPullTarget(sub, 200009)).toEqual({ kind: 'existing', dir: folder })
  })

  it('updates project-<id>/ beside you when it is already there', () => {
    pulledFolder(path.join(root, 'project-200009'), 200009)

    expect(resolveProjectPullTarget(root, 200009)).toEqual({
      kind: 'existing',
      dir: path.join(root, 'project-200009'),
    })
  })

  it('scaffolds a fresh project-<id>/ when nothing is there', () => {
    expect(resolveProjectPullTarget(root, 200014)).toEqual({ kind: 'fresh', dir: path.join(root, 'project-200014') })
  })

  it('refuses a project-<id>/ folder that is not a pulled copy of that project', () => {
    fs.mkdirSync(path.join(root, 'project-200014'))

    expect(resolveProjectPullTarget(root, 200014).kind).toBe('blocked')
  })

  it('pulls a different project beside the one you are in, not over it', () => {
    const folder = path.join(root, 'project-200009')
    pulledFolder(folder, 200009)

    expect(resolveProjectPullTarget(folder, 200014)).toEqual({
      kind: 'fresh',
      dir: path.join(folder, 'project-200014'),
    })
  })
})

describe('updateProjectFile', () => {
  it('overwrites a locally edited script with the platform copy, as --force promises', () => {
    const folder = path.join(root, 'project-200009')
    pulledFolder(folder, 200009, 'function initProject(o) { /* local edit */ }\n')
    const remote = 'function initProject(o) { window.remote = true }\n'
    const data = {
      project: { editorProjectJs: remote, editorProjectTs: null, projectJsLang: 'JAVASCRIPT' },
    } as unknown as ApiProjectResponse['data']

    const updated = updateProjectFile(folder, manifestFor(200009), data)

    expect(updated).toContain('project.js')
    expect(fs.readFileSync(path.join(folder, 'project.js'), 'utf-8')).toBe(remote)
  })
})
