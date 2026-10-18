import { Command } from 'commander'
import { clearConfig, getConfigPath, readConfig } from '../lib/config.js'
import { readEnvToken, TOKEN_ENV_VAR } from '../lib/env.js'
import * as logger from '../lib/logger.js'
import { failCommand } from '../lib/output.js'

export const logoutCommand = new Command('logout')
  .description('Delete the saved logins on this machine')
  .action(() => {
    try {
      const read = readConfig()
      const savedCount = read.status === 'ok' ? read.config.logins.length : 0

      clearConfig()

      if (savedCount === 0) {
        logger.info(`No saved login found at ${getConfigPath()}`)
      } else {
        logger.success(
          `Deleted ${savedCount} saved login${savedCount === 1 ? '' : 's'} from ${getConfigPath()}`,
        )
      }

      // Saying "logged out" while an environment token still authenticates
      // every command would be false.
      if (readEnvToken()) {
        logger.warn(
          `${TOKEN_ENV_VAR} is still set, so commands can still authenticate. Unset it to finish signing out.`,
        )
      }
    } catch (err) {
      failCommand(err)
    }
  })
