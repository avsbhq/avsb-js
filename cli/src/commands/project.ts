import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import inquirer from 'inquirer'
import ora from 'ora'
import { ensureLoggedIn } from '../lib/config.js'
import { ApiClient } from '../lib/api.js'
import { compileTypeScript, compileScript } from '../lib/compiler.js'
import { startWatcher } from '../lib/watcher.js'
import { DEFAULT_HOST, describeDevServer, startDevServer } from '../lib/wsServer.js'
import {
  parseProjectInput,
  resolveProjectPullTarget,
  scaffoldProject,
  readProjectManifestOrExit,
  writeProjectManifest,
  updateProjectFile,
} from '../lib/projectScaffold.js'
import { CliError } from '../lib/cliError.js'
import { EXIT } from '../lib/exitCodes.js'
import { isInteractiveRun, refusalWithoutPrompt } from '../lib/interactive.js'
import * as logger from '../lib/logger.js'
import { failCommand } from '../lib/output.js'
import type { WsMessageFromCli, WsMessageFromExtension } from '../types/dev.js'
import type { WebSocket } from 'ws'

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

// ── Pull ────────────────────────────────────────────────────

const projectPullCommand = new Command('pull')
  .description('Pull project script from the platform')
  .argument('<project>', 'Project identifier (PRJ-42 or numeric ID)')
  .option('-f, --force', 'Overwrite local files without confirmation')
  .action(async (projectInput: string, options: { force?: boolean }) => {
    try {
      const config = ensureLoggedIn()

      let shortId: number
      try {
        shortId = parseProjectInput(projectInput)
      } catch {
        failCommand(
          new CliError('cli_usage', 'Invalid project identifier. Use PRJ-42 or a numeric ID.'),
        )
      }

      const api = new ApiClient(config)
      const spinner = ora('Fetching project...').start()

      let response
      try {
        response = await api.getProject(shortId)
        spinner.succeed('Project found')
      } catch (err) {
        spinner.fail('Failed to fetch project')
        failCommand(err)
      }

      const { project } = response.data

      logger.line()
      logger.heading(project.name)
      logger.label('ID', `PRJ-${project.shortId}`)
      logger.label('Language', project.projectJsLang === 'TYPESCRIPT' ? 'TypeScript' : 'JavaScript')
      logger.line()

      const target = resolveProjectPullTarget(process.cwd(), project.shortId)
      const dir = target.dir

      if (target.kind === 'blocked') {
        failCommand(
          new CliError('cli_usage', `${dir} already exists and is not a pulled copy of PRJ-${project.shortId}.`, [
            'Move or rename it, or run `avsb project pull` from another folder.',
          ]),
        )
      }

      if (target.kind === 'existing') {
        // Re-pull: update the existing folder in place, never a nested copy.
        const { manifest } = readProjectManifestOrExit(dir)

        if (!options.force) {
          const scriptFile = `project.${manifest.language}`
          const scriptPath = path.join(dir, scriptFile)
          const localContent = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf-8') : ''
          const remoteContent = manifest.language === 'ts'
            ? (project.editorProjectTs ?? project.editorProjectJs ?? '')
            : (project.editorProjectJs ?? '')

          if (localContent !== remoteContent && localContent !== '') {
            const refusal = refusalWithoutPrompt({
              code: 'cli_conflict',
              message: `Pulling would overwrite your local ${scriptFile}, and this run cannot ask first.`,
              hints: [`Run \`avsb project pull ${projectInput} --force\` to overwrite it.`],
            })
            if (refusal) failCommand(refusal)
            const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
              {
                type: 'confirm',
                name: 'proceed',
                message: 'Local file has changes. Pulling will overwrite them. Continue?',
                default: false,
              },
            ])
            if (!proceed) {
              logger.info('Pull aborted.')
              process.exit(EXIT.success)
            }
          }
        }

        const updateSpinner = ora('Updating files...').start()
        const updated = updateProjectFile(dir, manifest, response.data)

        if (updated.length > 0) {
          updateSpinner.succeed(`Files updated in ${path.relative(process.cwd(), dir) || 'this folder'}`)
          logger.fileTree(updated)
        } else {
          updateSpinner.succeed('Already up to date')
        }
      } else {
        // Fresh scaffold
        const scaffoldSpinner = ora('Scaffolding project files...').start()

        try {
          const result = scaffoldProject({ data: response.data, apiBaseUrl: config.apiBaseUrl, targetDir: dir })
          scaffoldSpinner.succeed('Files created')
          logger.line()
          logger.fileTree(result.files)
          logger.line()
          logger.success(`Project cloned to ${path.relative(process.cwd(), dir) || '.'}/`)
        } catch (err) {
          scaffoldSpinner.fail('Scaffolding failed')
          failCommand(err)
        }
      }
    } catch (err) {
      failCommand(err)
    }
  })

// ── Push ────────────────────────────────────────────────────

const projectPushCommand = new Command('push')
  .description('Compile and push project script to the platform')
  .option('-f, --force', 'Skip conflict check')
  .action(async (options: { force?: boolean }) => {
    try {
      const config = ensureLoggedIn()
      const { manifest, dir } = readProjectManifestOrExit()
      const api = new ApiClient(config)

      const scriptFile = `project.${manifest.language}`
      const scriptPath = path.join(dir, scriptFile)

      if (!fs.existsSync(scriptPath)) {
        failCommand(new CliError('cli_no_manifest', `File not found: ${scriptFile}`))
      }

      const source = fs.readFileSync(scriptPath, 'utf-8')

      // Compile locally — server stopped compiling, every push must arrive
      // pre-compiled or it's rejected with 400. Surface compile errors
      // here with line/col so the developer can fix them at the source.
      const projLang = manifest.language === 'ts' ? 'TYPESCRIPT' : 'JAVASCRIPT'
      const compileSpinner = ora(`Compiling ${scriptFile}...`).start()
      const compileResult = await compileScript(source, projLang, scriptFile, { minify: true })
      if (!compileResult.success) {
        compileSpinner.fail('Compilation failed')
        for (const e of compileResult.errors) {
          logger.error(`  ${e.file}:${e.line}:${e.column}: ${e.message}`)
        }
        process.exit(EXIT.failure)
      }
      compileSpinner.succeed('Compiled successfully')
      const compiledSource = compileResult.code

      // Conflict detection
      let spinner = ora('Pushing to platform...').start()

      if (!options.force && manifest.syncedHash) {
        spinner.text = 'Checking for remote changes...'
        const remote = await api.getProject(manifest.projectShortId)
        const remoteContent = manifest.language === 'ts'
          ? (remote.data.project.editorProjectTs ?? remote.data.project.editorProjectJs ?? '')
          : (remote.data.project.editorProjectJs ?? '')
        const remoteHash = remoteContent ? sha256(remoteContent) : undefined

        if (remoteHash !== manifest.syncedHash) {
          spinner.warn('Remote has changes you haven\'t pulled')
          logger.line()

          if (!isInteractiveRun()) {
            failCommand(
              new CliError(
                'cli_conflict',
                'The platform copy changed since your last pull, and this run cannot ask before overwriting it.',
                [
                  'Run `avsb project pull --force` to fetch the remote script first (it overwrites your local file),',
                  'or `avsb project push --force` to overwrite the remote changes.',
                ],
              ),
            )
          }
          const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
            {
              type: 'confirm',
              name: 'proceed',
              message: 'Pushing will overwrite remote changes. Continue?',
              default: false,
            },
          ])

          if (!proceed) {
            logger.info('Push aborted. Run `avsb project pull` to fetch remote changes first.')
            process.exit(EXIT.success)
          }

          spinner = ora('Pushing to platform...').start()
        } else {
          spinner.text = 'Pushing to platform...'
        }
      }

      // Push source + compiled output. Field choice depends on lang —
      // the server uses the matching column for projectJs (compiled out).
      const payload = manifest.language === 'ts'
        ? { editorProjectTs: { source, compiled: compiledSource } }
        : { editorProjectJs: { source, compiled: compiledSource } }
      try {
        await api.pushProject(manifest.projectShortId, payload)
      } catch (err) {
        spinner.fail('Push refused')
        // Both body fields are this one file, so a refusal names it.
        failCommand(err, { labelForPath: (bodyPath) => (bodyPath.length > 0 ? scriptFile : undefined) })
      }

      // Update sync hash
      manifest.syncedHash = sha256(source)
      manifest.lastSyncedAt = new Date().toISOString()
      writeProjectManifest(dir, manifest)

      spinner.succeed('Pushed successfully')
      logger.line()
      // The editor's save works the same way: saved, not live.
      logger.info('Saved as unpublished changes. Publish the script from the project\'s Snippet settings to put it live.')
      logger.success('Push complete')
    } catch (err) {
      failCommand(err)
    }
  })

// ── Dev ─────────────────────────────────────────────────────

const projectDevCommand = new Command('dev')
  .description('Watch project script and hot-reload via browser extension')
  .option('--host <host>', 'Address to listen on: 127.0.0.1 is this machine only, 0.0.0.0 is every interface', DEFAULT_HOST)
  .action(async (opts: { host: string }) => {
    try {
      ensureLoggedIn()
      const { manifest, dir } = readProjectManifestOrExit()

      const scriptFile = `project.${manifest.language}`
      const scriptPath = path.join(dir, scriptFile)

      logger.heading(`Dev mode: ${manifest.projectName} (project script)`)
      logger.line()

      // Initial compile
      let compiledJs: string
      const source = fs.readFileSync(scriptPath, 'utf-8')
      if (manifest.language === 'ts') {
        const spinner = ora('Compiling...').start()
        try {
          compiledJs = await compileTypeScript(source)
          spinner.succeed('Initial compile succeeded')
        } catch (err) {
          spinner.fail('Initial compile failed')
          failCommand(err)
        }
      } else {
        compiledJs = source
        logger.success('Initial compile succeeded')
      }

      const server = await startDevServer({
        experimentName: `${manifest.projectName} (project script)`,
        experimentId: manifest.projectId,
        host: opts.host,
        onExtensionMessage(msg: WsMessageFromExtension, ws: WebSocket) {
          if (msg.type === 'ext:connect') {
            const initMsg: WsMessageFromCli = {
              type: 'project:init',
              projectId: manifest.projectId,
              snippetKey: manifest.snippetKey,
              projectJs: compiledJs,
              compiledAt: Date.now(),
            }
            ws.send(JSON.stringify(initMsg))
            logger.info(`Extension connected from ${msg.pageUrl}`)
          }
        },
      })

      logger.line()
      const listening = describeDevServer(server)
      logger.success(listening.line)
      if (listening.warning) logger.warn(listening.warning)
      logger.info('Watching for changes...')
      logger.line()

      const watcher = startWatcher({
        dir,
        extensions: ['.ts', '.js'],
        onChange: async (filePath: string) => {
          const relativePath = path.relative(dir, filePath)
          logger.info(`File changed: ${relativePath}`)

          try {
            const newSource = fs.readFileSync(filePath, 'utf-8')
            compiledJs = manifest.language === 'ts'
              ? await compileTypeScript(newSource)
              : newSource

            const updateMsg: WsMessageFromCli = {
              type: 'project:update',
              projectId: manifest.projectId,
              projectJs: compiledJs,
              compiledAt: Date.now(),
            }
            server.broadcast(updateMsg)

            const clientCount = server.getClientCount()
            logger.success(
              `Compiled and sent to ${clientCount} client${clientCount === 1 ? '' : 's'}`
            )
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error'

            const errorMsg: WsMessageFromCli = {
              type: 'dev:error',
              file: relativePath,
              errors: [{ line: 0, column: 0, message }],
            }
            server.broadcast(errorMsg)

            logger.error(`Compile error in ${relativePath}: ${message}`)
          }
        },
      })

      const cleanup = async () => {
        logger.line()
        logger.info('Shutting down...')
        watcher.close()
        await server.close()
        logger.success('Dev server stopped')
        process.exit(EXIT.success)
      }

      process.on('SIGINT', cleanup)
      process.on('SIGTERM', cleanup)
    } catch (err) {
      failCommand(err)
    }
  })

// ── Parent command ──────────────────────────────────────────

export const projectCommand = new Command('project')
  .description('Manage project-level scripts')

projectCommand.addCommand(projectPullCommand)
projectCommand.addCommand(projectPushCommand)
projectCommand.addCommand(projectDevCommand)
