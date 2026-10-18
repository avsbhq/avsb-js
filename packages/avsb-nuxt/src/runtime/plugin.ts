/**
 * The one plugin the module registers.
 *
 * Server: fetch the datafile (once per process per TTL, deduplicated across
 * concurrent requests), park it in `useState` so it travels to the browser in
 * the payload, and install the Vue plugin with a client that has no timers, no
 * cache and no network. Flags are answered from that datafile, synchronously,
 * while the page renders.
 *
 * Browser: read the same datafile out of the payload, install the Vue plugin
 * with a live client that starts ready, and let it poll from there. Nothing is
 * fetched before the first paint and no flag flickers from default to real.
 *
 * `enforce: 'post'` so an app plugin that supplies its own bootstrap or
 * context (see `@avsbhq/nuxt/server`) has already run.
 */
import { defineNuxtPlugin, useRuntimeConfig, useState } from '#app';
import { consoleLogger } from '@avsbhq/core';
import type { EvalContext, FlagDatafile } from '@avsbhq/core';
import { AvsbPlugin } from '@avsbhq/vue';
import { buildAvsbClientOptions } from '../clientOptions';
import { readAvsbPublicConfig } from '../runtimeConfig';
import { AVSB_BOOTSTRAP_STATE_KEY, AVSB_CONTEXT_STATE_KEY } from '../stateKeys';

const logger = consoleLogger('warn');

const NOT_CONFIGURED =
  '[avsb] no SDK key, so no A vs B client was created and every composable in ' +
  'this app will throw where it is called. Set avsb.sdkKey in nuxt.config, or ' +
  'NUXT_PUBLIC_AVSB_SDK_KEY in the environment. The key for each environment is ' +
  'on app.avsb.cloud under Environments in the project sidebar, and looks like ' +
  '"sdk_production_ttqm0eaj4vth1krcb2xn".';

export default defineNuxtPlugin({
  name: 'avsb',
  enforce: 'post',

  async setup(nuxtApp) {
    const config = readAvsbPublicConfig(useRuntimeConfig().public['avsb']);

    if (config === null) {
      logger.error(NOT_CONFIGURED);
      return;
    }

    const bootstrap = useState<FlagDatafile | null>(AVSB_BOOTSTRAP_STATE_KEY, () => null);
    const context = useState<EvalContext | null>(AVSB_CONTEXT_STATE_KEY, () => null);

    if (import.meta.server && config.bootstrap && bootstrap.value === null) {
      // Imported here, not at the top: `import.meta.server` is a build-time
      // constant, so this whole branch (and the server-only fetch helper it
      // pulls in) is dropped from the browser bundle.
      const { avsbDatafileLoader } = await import('../server');

      bootstrap.value = await avsbDatafileLoader.load(config.sdkKey, {
        cdnHost: config.cdnHost,
        timeoutMs: config.bootstrapTimeout,
        maxAgeMs: config.bootstrapMaxAge,
        onError: (error: Error) => {
          logger.warn(
            `[avsb] the datafile could not be fetched during rendering, so this ` +
              `page renders your default values and the browser will fetch it ` +
              `instead. ${error.message}`,
          );
        },
      });
    }

    nuxtApp.vueApp.use(
      AvsbPlugin,
      buildAvsbClientOptions({
        sdkKey: config.sdkKey,
        isServer: import.meta.server,
        bootstrap: bootstrap.value,
        context: context.value,
        client: config.client,
        cdnHost: config.cdnHost,
      }),
    );
  },
});
