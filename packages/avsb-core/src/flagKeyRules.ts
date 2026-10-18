// =====================================================================
// What a flag key may look like, and what the SDKs say when a read asks
// for one the datafile does not carry (N1-9 and N1-15, production QA
// 2026-10-01).
//
// THE DECISION (N1-9). The platform accepts flag keys made of lowercase
// letters, digits and underscores, starting with a letter, at most 100
// characters (app/_lib/validators/flag.ts, FLAG_KEY_PATTERN). The docs and
// READMEs used hyphenated examples (`new-checkout-flow`, `checkout-v2`) that
// the platform refuses to create, so a copied example read a flag that can
// never exist and silently got the default. The SDKs keep accepting any
// string (a lookup is a lookup, and the conformance corpus has hyphenated
// keys), every example now uses underscores, and a miss on a key that breaks
// the rule says so and suggests the spelling the platform would accept.
//
// The rule is mirrored here rather than imported because the SDK packages
// cannot depend on the app. Keep the two in step.
// =====================================================================

/** The platform's flag key rule. Mirrors app/_lib/validators/flag.ts. */
export const FLAG_KEY_PATTERN = /^[a-z][a-z0-9_]*$/

/** The platform's flag key length limit. Mirrors app/_lib/validators/flag.ts. */
export const FLAG_KEY_MAX_LENGTH = 100

/** True when the platform would accept `key` as a flag key. */
export function isPlatformFlagKey(key: string): boolean {
  return key.length <= FLAG_KEY_MAX_LENGTH && FLAG_KEY_PATTERN.test(key)
}

/**
 * The spelling the platform would accept for a key it would refuse, or null
 * when the key is already valid or there is no obvious fix (a key that does
 * not start with a letter).
 *
 * ```ts
 * suggestFlagKey('new-checkout-flow') // 'new_checkout_flow'
 * suggestFlagKey('Dark Mode')         // 'dark_mode'
 * suggestFlagKey('checkout_v2')       // null, already valid
 * ```
 */
export function suggestFlagKey(key: string): string | null {
  if (isPlatformFlagKey(key)) return null
  const candidate = key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return isPlatformFlagKey(candidate) ? candidate : null
}

/** Where a read looked for the key and did not find it. */
export type FlagLookupSource = 'datafile' | 'snapshot'

/**
 * The one message every SDK logs (once per key) when a read asks for a key
 * the datafile does not carry. Distinct from a type mismatch on purpose: the
 * old typed-getter wording ("is not a boolean flag (flag declared as boolean
 * was not found)") sent people looking for a type problem that did not exist.
 */
export function flagNotFoundMessage(
  flagKey: string,
  where: FlagLookupSource = 'datafile'
): string {
  const missing =
    where === 'snapshot'
      ? `AvsB flag "${flagKey}" is not in the server bootstrap snapshot, so reads return the ` +
        'default you passed (source "not_found") until a datafile loads. The server ' +
        'evaluated every flag in its datafile.'
      : `AvsB flag "${flagKey}" is not in this environment's datafile, so reads return the ` +
        'default you passed (source "not_found").'

  if (isPlatformFlagKey(flagKey)) {
    return (
      `${missing} Check the key against the Flags page in the A vs B dashboard; ` +
      'archived flags are left out of the datafile.'
    )
  }
  const suggestion = suggestFlagKey(flagKey)
  const rule =
    'A vs B flag keys use lowercase letters, digits and underscores, starting with a letter'
  return suggestion
    ? `${missing} ${rule}: did you mean "${suggestion}"?`
    : `${missing} ${rule}, so check the key against the Flags page in the A vs B dashboard.`
}
