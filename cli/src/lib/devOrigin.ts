/**
 * Who may open a WebSocket to the `avsb dev` server.
 *
 * The server streams your experiment code to the browser extension and takes
 * messages back. A browser lets any web page open a WebSocket to localhost, and
 * the 2026-10-15 production retest saw the server accept one sent as
 * `https://evil.example`. The browser always sets the Origin header on a
 * WebSocket handshake and page script cannot change it, so the header says
 * which page (or extension) is asking. Allowed:
 *
 * - no Origin header: not a browser (a script, a test, another tool on this
 *   machine), which could reach the port directly anyway;
 * - pages served from this machine: `localhost`, `127.0.0.1` and `[::1]`, over
 *   http or https, any port;
 * - a browser extension: `chrome-extension://<id>` (Chrome and Edge) and
 *   `moz-extension://<uuid>` (Firefox).
 *
 * Any extension id, not only the Web Store one, because the docs offer the
 * extension as a zip to load unpacked, and an unpacked extension's id comes
 * from its folder path; Firefox gives every install a random id. A web page can
 * never present an extension origin, which is the attack this closes.
 *
 * Everything else, including `null` (a sandboxed frame or a file page),
 * look-alikes such as `http://localhost.evil.example`, and any public site, is
 * refused.
 */

const LOCAL_PAGE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/
const CHROME_EXTENSION = /^chrome-extension:\/\/[a-p]{32}$/
const FIREFOX_EXTENSION = /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** True when a WebSocket handshake with this Origin header may connect. */
export function isAllowedDevOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true
  const value = origin.trim().toLowerCase()
  return LOCAL_PAGE.test(value) || CHROME_EXTENSION.test(value) || FIREFOX_EXTENSION.test(value)
}

/** The HTTP status a refused handshake gets. */
export const REFUSED_ORIGIN_STATUS = 403
