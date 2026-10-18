/**
 * The two `useState` keys this module reads and writes.
 *
 * Their own file so the runtime plugin can import them without also importing
 * the server-side datafile loader (which would drag `@avsbhq/browser/server`
 * into the browser bundle for something that only ever runs during rendering).
 *
 * Both are re-exported from `@avsbhq/nuxt/server`, which is the path apps
 * import them from.
 */

/** The datafile for this request, serialised into the payload. */
export const AVSB_BOOTSTRAP_STATE_KEY = 'avsb:bootstrap';

/** The evaluation context for this request, serialised into the payload. */
export const AVSB_CONTEXT_STATE_KEY = 'avsb:context';
