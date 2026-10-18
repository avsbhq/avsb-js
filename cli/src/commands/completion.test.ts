import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Command } from 'commander'
import {
  buildCompletionCommand,
  commandNames,
  completionEntries,
  completionScript,
  type CompletionEntry,
} from './completion.js'

function program(): Command {
  const root = new Command('avsb').version('1.0.0')
  root.addCommand(new Command('login').option('--token <token>').option('--no-input'))
  const flags = new Command('flags')
  flags.addCommand(new Command('list').option('--json').option('--limit <n>'))
  flags.addCommand(new Command('toggle').option('--env <key>').option('--on').option('--off'))
  root.addCommand(flags)
  root.addCommand(new Command('listen').option('--forward <url>'))
  root.addCommand(new Command('codegen').option('--check'))
  root.addCommand(buildCompletionCommand(root))
  return root
}

function entry(entries: CompletionEntry[], path: string): CompletionEntry | undefined {
  return entries.find((candidate) => candidate.path === path)
}

describe('commandNames', () => {
  it('reads the real command list, completion included, so a new command is completable at once', () => {
    expect(commandNames(program())).toEqual(['codegen', 'completion', 'flags', 'listen', 'login'])
  })
})

// QA N4-19: only top-level names, offered at every position, no subcommands,
// no flags, and `completion` itself missing.
describe('completionEntries', () => {
  const entries = completionEntries(program())

  it('lists every command at the top level, completion included, plus the root flags', () => {
    expect(entry(entries, '')).toEqual({
      path: '',
      words: ['codegen', 'completion', 'flags', 'listen', 'login'],
      flags: ['--help', '--version'],
    })
  })

  it('gives each group its subcommands, and each command its own flags', () => {
    expect(entry(entries, 'flags')?.words).toEqual(['list', 'toggle'])
    expect(entry(entries, 'flags toggle')?.flags).toEqual(['--env', '--help', '--off', '--on'])
    expect(entry(entries, 'login')?.flags).toEqual(['--help', '--no-input', '--token'])
  })

  it('offers the shells as the completion command\'s argument', () => {
    expect(entry(entries, 'completion')?.words).toEqual(['bash', 'zsh', 'fish'])
  })
})

describe('completionScript', () => {
  const entries = completionEntries(program())

  it('registers a bash completion function against avsb', () => {
    const script = completionScript('bash', entries)

    expect(script).toContain('complete -F _avsb_completions avsb')
    expect(script).toContain('"flags toggle") offer="--env --help --off --on" ;;')
  })

  it('emits a zsh compdef that never touches the special path variable', () => {
    const script = completionScript('zsh', entries)

    expect(script).toContain('compdef _avsb avsb')
    expect(script).toContain("('flags') offer=('list' 'toggle' '--help') ;;")
    expect(script).not.toMatch(/local path\b/)
  })

  it('emits fish completions conditioned on the command path', () => {
    const script = completionScript('fish', entries)

    expect(script).toContain(`complete -c avsb -n 'test (__avsb_path) = "flags"' -f -a 'list toggle'`)
    expect(script).toContain(`complete -c avsb -n 'test (__avsb_path) = "flags list"' -l limit`)
  })

  it('tells the reader how to install each one', () => {
    expect(completionScript('bash', [])).toContain('~/.bashrc')
    expect(completionScript('zsh', [])).toContain('~/.zshrc')
    expect(completionScript('fish', [])).toContain('completions/avsb.fish')
  })
})

describe('the bash script, run by bash', () => {
  const script = completionScript('bash', completionEntries(program()))

  function complete(words: string[]): string[] {
    const quoted = words.map((word) => `'${word}'`).join(' ')
    const result = spawnSync(
      'bash',
      ['-c', `${script}\nCOMP_WORDS=(${quoted}); COMP_CWORD=${words.length - 1}; _avsb_completions; printf '%s\\n' "\${COMPREPLY[@]}"`],
      { encoding: 'utf-8' },
    )
    return result.stdout.split('\n').filter((line) => line.length > 0)
  }

  it('completes a subcommand inside its group, not a top-level command that shares the prefix', () => {
    expect(complete(['avsb', 'flags', 'li'])).toEqual(['list'])
    expect(complete(['avsb', 'li'])).toEqual(['listen'])
  })

  it('completes the flags of the command on the line, skipping positional arguments', () => {
    expect(complete(['avsb', 'flags', 'toggle', 'checkout_v2', '--o'])).toEqual(['--off', '--on'])
  })

  it('completes the completion command itself and its shells', () => {
    expect(complete(['avsb', 'comp'])).toEqual(['completion'])
    expect(complete(['avsb', 'completion', 'z'])).toEqual(['zsh'])
  })
})

// FU-38: the fish script used to be checked as text only. When fish is on PATH
// the script is written to a file and run by fish itself: a syntax check, then
// `complete -C`, which asks fish what it would offer for a half-typed line.
// Without fish the block is skipped and its title says why.
const FISH = spawnSync('which', ['fish'], { encoding: 'utf-8' }).stdout.trim()
const FISH_SKIP_REASON = FISH ? '' : ' (SKIPPED: fish is not on PATH, so the script was not run; install fish to run it)'

describe.skipIf(!FISH)(`the fish script, run by fish${FISH_SKIP_REASON}`, () => {
  const dir = FISH ? fs.mkdtempSync(path.join(os.tmpdir(), 'avsb-fish-')) : ''
  const file = path.join(dir, 'avsb.fish')
  if (FISH) fs.writeFileSync(file, completionScript('fish', completionEntries(program())))

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  /** What fish offers for a line, without descriptions; the escaping keeps the line one argument. */
  function complete(line: string): string[] {
    const result = spawnSync(FISH, ['--no-config', '-c', `source ${file}; complete -C '${line}'`], {
      encoding: 'utf-8',
    })
    expect(result.stderr).toBe('')
    return result.stdout
      .split('\n')
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.split('\t')[0])
      .sort()
  }

  it('passes fish -n, the syntax check', () => {
    const result = spawnSync(FISH, ['--no-config', '-n', file], { encoding: 'utf-8' })

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('offers the top-level commands after "avsb ", and no file names beside them', () => {
    expect(complete('avsb ')).toEqual(['codegen', 'completion', 'flags', 'listen', 'login'])
  })

  it('completes a subcommand inside its group, not a top-level command that shares the prefix', () => {
    expect(complete('avsb flags li')).toEqual(['list'])
    expect(complete('avsb li')).toEqual(['listen'])
  })

  it('completes the flags of the command on the line, skipping positional arguments', () => {
    expect(complete('avsb flags toggle checkout_v2 --o')).toEqual(['--off', '--on'])
  })

  it('completes the completion command\'s shells', () => {
    expect(complete('avsb completion ')).toEqual(['bash', 'fish', 'zsh'])
  })
})
