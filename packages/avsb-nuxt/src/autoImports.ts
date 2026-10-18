/**
 * The composables the module auto-imports from `@avsbhq/vue`.
 *
 * One list, in one file, because it is the kind of thing that silently rots:
 * rename a composable in `@avsbhq/vue` and a stale entry here becomes an
 * auto-import that resolves to nothing. `autoImports.test.ts` asserts this
 * list against the package's real exports, so a rename breaks a test instead
 * of an app.
 *
 * `AvsbProvider`, `AvsbPlugin` and `AvsbInjectionKey` are deliberately absent:
 * the module installs the plugin itself, and auto-importing a second provider
 * would invite the nested-provider mistake (two clients, two visitor ids).
 */
export const AVSB_VUE_AUTO_IMPORTS = [
  // Reading flags
  'useFlag',
  'useFlagValue',
  'useBoolFlag',
  'useStringFlag',
  'useNumberFlag',
  'useJsonFlag',
  'useAllFlags',
  // Readiness and errors
  'useFlagReady',
  'useAvsbStatus',
  // The client itself
  'useAvsbClient',
  // Identity
  'useIdentify',
  'useAlias',
  'useReset',
  // Events
  'useTrack',
  'useExposure',
  'useFlagSubscription',
] as const;

export type AvsbVueAutoImport = (typeof AVSB_VUE_AUTO_IMPORTS)[number];

/** The package the composables come from. */
export const AVSB_VUE_PACKAGE = '@avsbhq/vue';
