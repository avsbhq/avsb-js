/**
 * `@avsbhq/nuxt`: A vs B feature flags in one line of `nuxt.config`.
 *
 * ```ts
 * export default defineNuxtConfig({
 *   modules: ['@avsbhq/nuxt'],
 *   avsb: { sdkKey: process.env.AVSB_SDK_KEY },
 * })
 * ```
 *
 * What that does:
 *
 * 1. Publishes the settings to `runtimeConfig.public.avsb`, so
 *    `NUXT_PUBLIC_AVSB_SDK_KEY` can point a built app at another environment
 *    without a rebuild.
 * 2. Auto-imports the `@avsbhq/vue` composables, so components call
 *    `useBoolFlag('new-checkout-flow', false)` with no import line.
 * 3. Registers one plugin that fetches the datafile during server rendering,
 *    sends it to the browser in the payload, and installs the Vue plugin on
 *    both sides. The first paint shows real values, not defaults.
 *
 * This file stays thin on purpose: every decision it makes lives in
 * `./options`, `./autoImports` and `./clientOptions`, which are plain
 * TypeScript with tests. What is left here is Nuxt wiring.
 */
import {
  addImportsSources,
  addPlugin,
  createResolver,
  defineNuxtModule,
  useLogger,
} from '@nuxt/kit';
import { AVSB_VUE_AUTO_IMPORTS, AVSB_VUE_PACKAGE } from './autoImports';
import { AVSB_MODULE_DEFAULTS, resolveModuleOptions } from './options';
import type { AvsbModuleOptions, AvsbPublicRuntimeConfig } from './options';

export type { AvsbModuleOptions, AvsbPublicRuntimeConfig } from './options';
export type { AvsbClientRuntimeOptions } from './clientOptions';

export default defineNuxtModule<AvsbModuleOptions>({
  meta: {
    name: '@avsbhq/nuxt',
    configKey: 'avsb',
    compatibility: {
      // 3.7 is the release that introduced `import.meta.server`, which the
      // runtime plugin uses to tell a server render from a browser one.
      nuxt: '>=3.7.0',
    },
  },

  defaults: AVSB_MODULE_DEFAULTS,

  setup(options, nuxt) {
    const logger = useLogger('avsb');
    const resolved = resolveModuleOptions(options, process.env);

    if (resolved.warning !== null) logger.warn(resolved.warning);

    nuxt.options.runtimeConfig.public['avsb'] = resolved.runtimeConfig;

    if (resolved.autoImports) {
      addImportsSources({
        from: AVSB_VUE_PACKAGE,
        imports: [...AVSB_VUE_AUTO_IMPORTS],
      });
    }

    const resolver = createResolver(import.meta.url);

    // `mode: 'all'`: the plugin runs on the server (fetch the datafile, put it
    // in the payload, render real values) and in the browser (adopt that
    // datafile, then keep the client live). A client-only plugin would leave
    // every composable without a client during server rendering, which throws
    // in the component that reads a flag.
    addPlugin({
      src: resolver.resolve('./runtime/plugin'),
      mode: 'all',
    });
  },
});

declare module '@nuxt/schema' {
  interface NuxtConfig {
    avsb?: AvsbModuleOptions;
  }

  interface NuxtOptions {
    avsb?: AvsbModuleOptions;
  }

  interface PublicRuntimeConfig {
    avsb?: AvsbPublicRuntimeConfig;
  }
}
