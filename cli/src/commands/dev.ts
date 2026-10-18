import { Command } from 'commander'
import path from 'node:path'
import { ensureLoggedIn } from '../lib/config.js'
import { readManifestOrExit } from '../lib/manifest.js'
import { compileExperiment, detectChangeType } from '../lib/compiler.js'
import { startWatcher } from '../lib/watcher.js'
import { DEFAULT_HOST, describeDevServer, startDevServer } from '../lib/wsServer.js'
import { EXIT } from '../lib/exitCodes.js'
import * as logger from '../lib/logger.js'
import { failCommand } from '../lib/output.js'
import type { CompiledExperiment, WsMessageFromCli, WsMessageFromExtension } from '../types/dev.js'
import type { WebSocket } from 'ws'

export const devCommand = new Command('dev')
  .description('Start dev server with live reload for the browser extension')
  .option('--host <host>', 'Address to listen on: 127.0.0.1 is this machine only, 0.0.0.0 is every interface', DEFAULT_HOST)
  .action(async (opts: { host: string }) => {
    try {
      ensureLoggedIn()
      const { manifest, dir } = readManifestOrExit()

      logger.heading(`Dev mode: ${manifest.experimentName}`)
      logger.line()

      let compiled: CompiledExperiment
      try {
        compiled = await compileExperiment(dir, manifest)
        logger.success('Initial compile succeeded')
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Compilation failed'
        logger.error(`Initial compile failed: ${message}`)
        process.exit(EXIT.failure)
      }

      const server = await startDevServer({
        experimentName: manifest.experimentName,
        experimentId: manifest.experimentId,
        host: opts.host,
        onExtensionMessage(msg: WsMessageFromExtension, ws: WebSocket) {
          if (msg.type === 'ext:connect') {
            const initMsg: WsMessageFromCli = {
              type: 'dev:init',
              experimentId: manifest.experimentId,
              experimentName: manifest.experimentName,
              snippetKey: manifest.snippetKey,
              triggersJs: compiled.triggersJs,
              variations: compiled.variations,
              compiledAt: compiled.compiledAt,
              allowedVariations: manifest.allowedVariations ?? [],
            }
            ws.send(JSON.stringify(initMsg))
            logger.info(`Extension connected from ${msg.pageUrl}`)
          }

          if (msg.type === 'ext:switch-variation') {
            const variation = compiled.variations.find(
              (v) => v.variationId === (msg as { variationId: string }).variationId
            )
            if (variation) {
              logger.info(`Variation switched to: ${variation.name}`)
            }
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
        extensions: ['.ts', '.js', '.scss', '.css'],
        onChange: async (filePath: string) => {
          const relativePath = path.relative(dir, filePath)
          logger.info(`File changed: ${relativePath}`)

          try {
            compiled = await compileExperiment(dir, manifest)
            const changeType = detectChangeType(filePath)

            const updateMsg: WsMessageFromCli = {
              type: 'dev:update',
              experimentId: manifest.experimentId,
              changeType,
              triggersJs: compiled.triggersJs,
              variations: compiled.variations,
              compiledAt: compiled.compiledAt,
              allowedVariations: manifest.allowedVariations ?? [],
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
