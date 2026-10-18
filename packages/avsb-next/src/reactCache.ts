// React's per-request memo, without a hard dependency on it.
//
// `cache()` exists in React 19 and in the 18.3 line Next 15 ships. This
// package's peer range starts at React 18, where it does not, and a bare
// named import would be a build-time failure rather than a graceful
// degradation. Read off the namespace instead: with `cache`, one datafile
// fetch serves every server component in a request; without it, the fetch
// falls back to Next's own fetch cache and still does not hit the CDN
// twice in a revalidate window.

import * as React from 'react'

type CacheFn = <F extends (...args: never[]) => unknown>(fn: F) => F

// The React namespace object is typed by whichever @types/react version is
// installed, which may or may not declare `cache`. Reading it through a
// narrow shape keeps this honest without `any`.
const maybeCache = (React as unknown as { cache?: CacheFn }).cache

/** `React.cache` when the installed React has it, otherwise a pass-through. */
export const perRequestCache: CacheFn = maybeCache ?? ((fn) => fn)

/** True when the running React deduplicates calls within one request. */
export const hasPerRequestCache: boolean = typeof maybeCache === 'function'
