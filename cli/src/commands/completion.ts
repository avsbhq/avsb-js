/**
 * `avsb completion <shell>` — print a shell completion script.
 *
 * Printed rather than installed: writing to a user's shell configuration
 * without asking is not the CLI's business, and printing means the same command
 * works in an `eval` line, a dotfile, or a package manager's completion
 * directory.
 *
 * The tree is generated from the program itself, so a new command, subcommand
 * or flag is completable the moment it is registered. It used to list the
 * top-level names only, offered at every position (`avsb flags li<TAB>`
 * suggested `listen`), with no subcommands, no flags, and without
 * `completion` itself (QA N4-19). Every script now works out which command the
 * line is in, from the words already typed, and offers that command's
 * subcommands and flags.
 */

import { Command } from 'commander'
import { CliError } from '../lib/cliError.js'
import * as logger from '../lib/logger.js'
import { beginCommand, failCommand } from '../lib/output.js'
import { OPEN_TARGETS } from './open.js'

export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const

export type CompletionShell = (typeof COMPLETION_SHELLS)[number]

/** One command in the tree: what may follow it on the line. */
export interface CompletionEntry {
  /** Space-joined command path: '' for `avsb` itself, 'flags list' for `avsb flags list`. */
  path: string
  /** Subcommands, and fixed argument values such as a shell name. */
  words: string[]
  /** Long flags, including --help. */
  flags: string[]
}

/** Fixed values for a command's first argument, where the set is known. */
const ARGUMENT_CHOICES: Record<string, readonly string[]> = {
  completion: COMPLETION_SHELLS,
  open: OPEN_TARGETS,
}

function flagsOf(command: Command, isRoot: boolean): string[] {
  const flags = command.options
    .map((option) => option.long)
    .filter((long): long is string => typeof long === 'string')
  flags.push('--help')
  if (isRoot) flags.push('--version')
  return [...new Set(flags)].sort()
}

/** Every command in the program, depth first, with what may follow it. */
export function completionEntries(program: Command): CompletionEntry[] {
  const entries: CompletionEntry[] = []

  function visit(command: Command, path: string): void {
    const subcommands = command.commands.map((child) => child.name()).sort()
    entries.push({
      path,
      words: [...subcommands, ...(ARGUMENT_CHOICES[path] ?? [])],
      flags: flagsOf(command, path === ''),
    })
    for (const child of command.commands) {
      visit(child, path === '' ? child.name() : `${path} ${child.name()}`)
    }
  }

  visit(program, '')
  return entries
}

/** Top-level command names, `completion` included. */
export function commandNames(program: Command): string[] {
  return program.commands.map((command) => command.name()).sort()
}

const quoteBash = (value: string): string => `"${value}"`

export function bashCompletion(entries: CompletionEntry[]): string {
  const known = entries.filter((entry) => entry.path !== '').map((entry) => quoteBash(entry.path))
  const cases = entries.map((entry) => {
    const offer = [...entry.words, ...entry.flags].join(' ')
    return `    ${quoteBash(entry.path)}) offer="${offer}" ;;`
  })

  return `# avsb completion for bash. Add to ~/.bashrc:
#   eval "$(avsb completion bash)"
_avsb_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" cmdpath="" word candidate i offer=""
  for ((i = 1; i < COMP_CWORD; i++)); do
    word="\${COMP_WORDS[i]}"
    [[ "$word" == -* ]] && continue
    candidate="\${cmdpath:+$cmdpath }$word"
    case "$candidate" in
      ${known.length > 0 ? known.join('|') : '"__none__"'}) cmdpath="$candidate" ;;
    esac
  done
  case "$cmdpath" in
${cases.join('\n')}
  esac
  COMPREPLY=($(compgen -W "$offer" -- "$cur"))
}
complete -F _avsb_completions avsb`
}

const quoteZsh = (value: string): string => `'${value}'`

export function zshCompletion(entries: CompletionEntry[]): string {
  const known = entries.filter((entry) => entry.path !== '').map((entry) => quoteZsh(entry.path))
  const cases = entries.map((entry) => {
    const offer = [...entry.words, ...entry.flags].map(quoteZsh).join(' ')
    return `    (${quoteZsh(entry.path)}) offer=(${offer}) ;;`
  })

  // `path` is special in zsh (it IS $PATH), so the walk keeps its own name.
  return `# avsb completion for zsh. Add to ~/.zshrc:
#   eval "$(avsb completion zsh)"
_avsb() {
  local cmdpath="" word candidate i
  local -a offer
  for ((i = 2; i < CURRENT; i++)); do
    word="\${words[i]}"
    [[ "$word" == -* ]] && continue
    candidate="\${cmdpath:+$cmdpath }$word"
    case "$candidate" in
      (${known.length > 0 ? known.join('|') : "'__none__'"}) cmdpath="$candidate" ;;
    esac
  done
  case "$cmdpath" in
${cases.join('\n')}
  esac
  compadd -- $offer
}
compdef _avsb avsb`
}

const quoteFish = (value: string): string => `'${value}'`

export function fishCompletion(entries: CompletionEntry[]): string {
  const known = entries.filter((entry) => entry.path !== '').map((entry) => quoteFish(entry.path))
  const lines: string[] = []
  for (const entry of entries) {
    const condition = `'test (__avsb_path) = "${entry.path}"'`
    if (entry.words.length > 0) {
      // -f: where a command takes a subcommand or a fixed value, a file name is
      // never right. Without it fish offered every file in the folder beside
      // the commands (found by running the script in fish, FU-38). A leaf
      // command's line keeps file names, since its arguments may be paths.
      lines.push(`complete -c avsb -n ${condition} -f -a ${quoteFish(entry.words.join(' '))}`)
    }
    for (const flag of entry.flags) {
      lines.push(`complete -c avsb -n ${condition} -l ${flag.replace(/^--/, '')}`)
    }
  }

  return [
    '# avsb completion for fish. Save as:',
    '#   avsb completion fish > ~/.config/fish/completions/avsb.fish',
    `set -g __avsb_known_paths ${known.join(' ')}`,
    // Drops the first token (`avsb`) with `set -e` rather than a [2..-1]
    // slice, and always prints exactly one line, so `test (__avsb_path) = ""`
    // compares one value even at the top level.
    'function __avsb_path',
    '  set -l tokens (commandline -opc)',
    '  set -e tokens[1]',
    '  set -l cmdpath',
    '  for word in $tokens',
    "    string match -q -- '-*' $word; and continue",
    "    set -l candidate (string join ' ' $cmdpath $word)",
    '    contains -- $candidate $__avsb_known_paths; and set cmdpath $cmdpath $word',
    '  end',
    "  echo (string join ' ' $cmdpath)",
    'end',
    ...lines,
  ].join('\n')
}

export function completionScript(shell: CompletionShell, entries: CompletionEntry[]): string {
  switch (shell) {
    case 'bash':
      return bashCompletion(entries)
    case 'zsh':
      return zshCompletion(entries)
    case 'fish':
      return fishCompletion(entries)
  }
}

/**
 * Built against the program so the tree is the real one. Called from `cli.ts`
 * after every command is registered, and needs no login: it reads nothing
 * from the platform.
 */
export function buildCompletionCommand(program: Command): Command {
  return new Command('completion')
    .argument('<shell>', `Shell to generate for: ${COMPLETION_SHELLS.join(' | ')}`)
    .description('Print a shell completion script')
    .action((shell: string) => {
      beginCommand('completion', {})
      const requested = shell.trim().toLowerCase()
      if (!(COMPLETION_SHELLS as readonly string[]).includes(requested)) {
        failCommand(
          new CliError('cli_usage', `No completion script for "${shell}".`, [
            `Supported shells: ${COMPLETION_SHELLS.join(', ')}.`,
          ]),
        )
      }
      logger.line(completionScript(requested as CompletionShell, completionEntries(program)))
    })
}
