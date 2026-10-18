/**
 * Every string a developer can read out of this package lives here, so the
 * wording stays consistent and each message names the fix.
 *
 * House rule for this file: say what failed, name the exact value involved,
 * and say where to fix it.
 */

/** Prefix on every message this package produces. */
const PREFIX = '[avsb]'

/**
 * Thrown when `AvsbService` is injected in an application that never called
 * `provideAvsb()` or imported `AvsbModule.forRoot()`. Failing loudly here is
 * deliberate: the alternative is an app that renders default values forever
 * with no signal, which is the exact silent failure this release removes.
 */
export const NO_CLIENT_MESSAGE =
  `${PREFIX} AvsbService was injected, but no A vs B client is configured. ` +
  'Add provideAvsb({ sdkKey: "sdk_<environment>_<id>" }) to the providers of ' +
  'bootstrapApplication(), or import AvsbModule.forRoot({ sdkKey }) in your ' +
  'AppModule. SDK keys are on app.avsb.cloud under Environments in the project sidebar.'

/** `Flag.reasons` entry used before the first datafile is applied. */
export const NOT_READY_REASON = 'SDK not ready: no datafile loaded yet'

/**
 * Fallback error for a failed init that arrived without one. The client
 * normally supplies a message naming the HTTP status and the URL it tried.
 */
export const INIT_FAILED_MESSAGE =
  `${PREFIX} The A vs B datafile could not be loaded, so every flag is ` +
  'answering with the default value you passed. Check that the sdkKey given ' +
  'to provideAvsb() matches an environment on app.avsb.cloud (Environments ' +
  'in the project sidebar), and that cdn.avsb.cloud is reachable from this ' +
  'browser.'

/**
 * Warning for `*avsbFlag` used with both value and variation matching. Both
 * must match, which is rarely what someone means.
 */
export function bothMatchersMessage(flagKey: string): string {
  return (
    `${PREFIX} *avsbFlag on "${flagKey}" sets both whenVariation and ` +
    'whenValue, so the template renders only when BOTH match. Drop one of ' +
    'them unless that is what you meant.'
  )
}
