// Local, DEV-ONLY typings for the two Nuxt virtual modules this package's
// runtime uses. They exist so `tsc --noEmit` can check `src/runtime/plugin.ts`
// without installing `nuxt` itself (this package only needs `@nuxt/kit` to
// build, and a full Nuxt install for a type shim would be a heavy devDep).
//
// This file is NEVER published: `files` ships `dist` only. That matters,
// because inside a real Nuxt app `#app` is declared by Nuxt, and a second
// declaration shipped from node_modules would collide with it.
//
// The build DOES emit `dist/runtime/plugin.d.ts` (tsup runs `dts: true` for
// every entry), and that emitted file is inert: `defineNuxtPlugin` is typed
// below as returning `unknown`, so the declaration is a bare
// `declare const _default: unknown` with no reference to `#app` in it.
//
// Keep these signatures narrow: only what src/runtime/plugin.ts actually calls.

declare module '#app' {
  export interface NuxtAppLike {
    vueApp: {
      use(plugin: unknown, options?: unknown): unknown;
    };
  }

  export interface NuxtPluginObject {
    name?: string;
    enforce?: 'pre' | 'default' | 'post';
    setup: (nuxtApp: NuxtAppLike) => void | Promise<void>;
  }

  export function defineNuxtPlugin(plugin: NuxtPluginObject): unknown;

  export function useRuntimeConfig(): { public: Record<string, unknown> };

  export function useState<T>(key: string, init: () => T): { value: T };
}

// `import.meta.server` / `import.meta.client` are Nuxt build-time constants
// (Nuxt 3.7 and later). Nuxt declares them for apps; this package declares them
// for its own typecheck only.
interface ImportMeta {
  readonly server: boolean;
  readonly client: boolean;
}
