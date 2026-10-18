/**
 * The typed flag-key contract: how a project's real flag keys become part of
 * the type system without breaking anyone who never generates them.
 *
 * `avsb codegen` (the `@avsbhq/cli` command) writes a file that declares the
 * project's flags:
 *
 *   declare global {
 *     interface AvsbFlags {
 *       checkout_v2: boolean
 *       hero_copy: 'control' | 'variant_a'
 *     }
 *   }
 *
 * Every typed getter in `@avsbhq/browser` and in the seven framework adapters
 * types its key parameter as `AvsbFlagKey`. Two outcomes, both correct:
 *
 *   - No generated file: `AvsbFlags` has no members, so `AvsbFlagKey` resolves
 *     to `string` and every existing call keeps compiling, byte for byte.
 *   - Generated file present: `AvsbFlagKey` is the union of that project's
 *     keys, so `getBoolFlag('chekcout_v2', false)` is a compile error and the
 *     editor completes real keys.
 *
 * WHY A GLOBAL INTERFACE, not `declare module '@avsbhq/core'`. There are eight
 * packages a consumer might install (browser plus seven adapters) and they must
 * all agree on one table, so the table can live in only one place. Augmenting
 * `@avsbhq/core` would require the consumer to resolve a package they never
 * installed directly, which fails under pnpm's strict layout and Yarn PnP. A
 * global interface is resolvable from any of the eight, under every package
 * manager, and needs no import in the generated file. The name is `Avsb`
 * prefixed precisely because it is global.
 *
 * Keys follow the platform rule in ./flagKeyRules.ts (lowercase letters,
 * digits and underscores, starting with a letter), which is why every example
 * here uses underscores.
 *
 * ESCAPE HATCH. A project that generated the table but reads a key computed at
 * runtime widens deliberately: `getBoolFlag(key as AvsbFlagKey, false)`. That
 * is a one-word, greppable opt-out rather than a silent hole in the contract.
 */

declare global {
  /**
   * The generated flag table for this project. Empty here on purpose: it is
   * augmented by the file `avsb codegen` writes, and by nothing else.
   *
   * Empty interfaces are normally a smell; this one is the entire point.
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the augmentation target must start empty
  interface AvsbFlags {}
}

/**
 * Every flag key this project declares, or `string` when nothing has been
 * generated.
 *
 * The tuple wrapper (`[keyof AvsbFlags] extends [never]`) stops the conditional
 * distributing over the union; without it a union of keys would be tested one
 * member at a time and the answer would be wrong.
 */
export type AvsbFlagKey = [keyof AvsbFlags] extends [never]
  ? string
  : Extract<keyof AvsbFlags, string>

/**
 * The value type the platform declared for one key, or `unknown` when there is
 * no generated table to ask.
 *
 * Useful for the JSON case, where the generated table carries the shape of the
 * variations: `getJsonFlag<AvsbFlagValue<'theme'>>('theme', fallback)`.
 */
export type AvsbFlagValue<K extends AvsbFlagKey> = K extends keyof AvsbFlags
  ? AvsbFlags[K]
  : unknown
