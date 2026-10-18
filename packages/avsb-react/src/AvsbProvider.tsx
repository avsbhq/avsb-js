import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import { AvsbClient } from '@avsbhq/browser'
import type { AvsbClientOptions } from '@avsbhq/browser'
import { AvsbContext } from './context'
import type { AvsbContextValue } from './context'
import type { ReactAvsbClient } from './clientInterface'
import { deriveStatus, sameStatus } from './providerStatus'
import type { AvsbStatusState } from './providerStatus'
import { reviveServerFlags } from './serverFlags'
import type { AvsbProviderProps, AvsbProviderSharedProps } from './types'
import { SDK_TYPE, SDK_VERSION } from './version'

// =====================================================================
// AvsbProvider. Two modes, one component.
//
//   Mode A (convenience): `sdkKey` plus any other AvsbClientOptions. The
//     provider creates the client, owns it, and closes it on unmount.
//   Mode B (injection): a pre-built `client`. The provider never closes
//     it, because the caller owns its lifecycle.
//
// THE BUG THIS FILE EXISTS TO KILL (report 03 §5 React, §7 item 10): the
// owned client was created lazily DURING RENDER and stored in a ref.
// React StrictMode runs setup, cleanup, setup, so the first cleanup
// closed the client and nulled the ref while the second setup carried on
// with the captured, closed instance. Nothing re-rendered, so every
// StrictMode app (the documented Vite quickstart) ran against a client
// with its polling stopped and its tracker destroyed.
//
// The fix is to create the client in an EFFECT and keep it in state:
// cleanup closes it, the next setup builds a fresh one, and the state
// update makes the tree re-render with the live client. A LAYOUT effect,
// not a passive one, so the client exists before the browser paints and a
// bootstrapped or cached datafile still renders real values on the first
// visible frame.
// =====================================================================

/** Layout effects do not run on the server, and warn if you try. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

const LOADING: AvsbStatusState = Object.freeze({
  status: 'loading' as const,
  degraded: false,
})

type ModeAProps = AvsbClientOptions & AvsbProviderSharedProps & { client?: never }

/**
 * Peel the provider's own props off and hand the rest to the client
 * constructor, so a new `AvsbClientOptions` field works here the day
 * `@avsbhq/browser` adds it.
 */
function clientOptionsFrom(props: AvsbProviderProps): AvsbClientOptions {
  const {
    children: _children,
    serverFlags: _serverFlags,
    client: _client,
    ...options
  } = props as ModeAProps
  return options
}

/**
 * What forces a rebuild of an owned client.
 *
 * Only the two options that change WHICH data plane the client talks to.
 * Everything else (`pollingInterval`, `logLevel`, `events`, and so on) is
 * read once at construction, and `context` changes are applied with
 * `identify` rather than by throwing the client away, which would lose the
 * visitor's queued events and re-randomise nothing but waste a fetch.
 *
 * The separator is a pipe, and deliberately not a NUL byte: a raw NUL in
 * the source makes git treat this whole file as binary, which hides every
 * future diff of the module that owns client ownership. Neither an SDK key
 * (`sdk_<env>_<cuid2>`) nor a CDN host can contain a pipe, so the two parts
 * stay unambiguous. `@avsbhq/browser`'s snapshotCache.ts documents the same
 * hazard.
 */
function buildKeyFrom(props: AvsbProviderProps): string {
  if ('client' in props) return 'injected'
  return `${props.sdkKey ?? ''}|${props.cdnHost ?? ''}`
}

function missingSdkKeyMessage(): string {
  return (
    '[avsb] <AvsbProvider> was rendered without an sdkKey, so no flags can be ' +
    'loaded and every read returns the default you passed. Pass the ' +
    'environment SDK key (it looks like "sdk_production_xxxxxxxx", copy it from ' +
    'Environments in the project sidebar, in the A vs B dashboard), or pass a pre-built ' +
    'client: <AvsbProvider client={myClient}>.'
  )
}

/** JSON that tolerates a value JSON cannot express. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

export function AvsbProvider(props: AvsbProviderProps): ReactElement {
  const { children, serverFlags = null } = props
  const injectedClient: ReactAvsbClient | null =
    'client' in props ? (props.client ?? null) : null

  // The newest props, reachable from effects WITHOUT making those effects
  // re-run: `context={{ kind: 'user', key: id }}` is a fresh object every
  // render, and a dependency on it would rebuild the client every render.
  const propsRef = useRef<AvsbProviderProps>(props)
  useIsomorphicLayoutEffect(() => {
    propsRef.current = props
  })

  const buildKey = buildKeyFrom(props)

  const [ownedClient, setOwnedClient] = useState<ReactAvsbClient | null>(null)
  const [statusState, setStatusState] = useState<AvsbStatusState>(LOADING)
  const client: ReactAvsbClient | null = injectedClient ?? ownedClient

  // --- Mode A: own the client, StrictMode-safely -----------------------
  useIsomorphicLayoutEffect(() => {
    if (injectedClient) return undefined

    const options = clientOptionsFrom(propsRef.current)
    if (!options.sdkKey) {
      // Loud, and not a crash: the tree still renders, every read returns
      // its default, and `useAvsbStatus()` says exactly what is wrong.
      setStatusState({ status: 'error', degraded: false, error: new Error(missingSdkKeyMessage()) })
      return undefined
    }

    // Report @avsbhq/react on the heartbeat, unless a package wrapping this
    // one (@avsbhq/next, @avsbhq/react-native) passed its own (N1-14).
    const created: ReactAvsbClient = new AvsbClient({
      ...options,
      wrapper: options.wrapper ?? { sdkType: SDK_TYPE, sdkVersion: SDK_VERSION },
    })
    setOwnedClient(created)

    return () => {
      // StrictMode's simulated remount runs this cleanup and then the setup
      // again. Dropping the reference here is what makes the second setup
      // build a FRESH client instead of leaving the tree on a closed one.
      setOwnedClient((current) => (current === created ? null : current))
      void created.close()
    }
  }, [injectedClient, buildKey])

  // --- Status, from the client's own answers ---------------------------
  useEffect(() => {
    if (!client) return undefined

    let cancelled = false
    let lastError: Error | undefined

    const sync = (): void => {
      if (cancelled) return
      const next = deriveStatus({
        readable: client.isReady(),
        initResult: client.getInitResult(),
        lastError,
      })
      setStatusState((previous) => (sameStatus(previous, next) ? previous : next))
    }

    // An injected client may already be ready, and a bootstrapped one is
    // ready on this tick: read the truth before waiting on anything.
    sync()

    const unsubscribes: Array<() => void> = [
      client.on('ready', () => {
        lastError = undefined
        sync()
      }),
      // A datafile landed, so whatever failed before has been superseded.
      client.on('configUpdate', () => {
        lastError = undefined
        sync()
      }),
      client.on('error', (error: Error) => {
        // NOT automatically fatal. A degraded init (stale cache served
        // after a failed refresh) emits this event AND resolves
        // `{success: true, degraded: true}`; `deriveStatus` decides.
        lastError = error
        sync()
      }),
    ]

    void client.onReady().then(sync)

    return () => {
      cancelled = true
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
  }, [client])

  // --- Provider-level context changes become identify() calls ----------
  const contextKey = 'client' in props || !props.context ? null : safeJson(props.context)
  const appliedContextRef = useRef<{ client: ReactAvsbClient; contextKey: string | null } | null>(
    null,
  )
  useEffect(() => {
    if (!client) return
    const previous = appliedContextRef.current
    appliedContextRef.current = { client, contextKey }
    // A newly built client was constructed WITH the current context.
    if (!previous || previous.client !== client) return
    if (contextKey === null || previous.contextKey === contextKey) return
    const latest = propsRef.current
    if ('client' in latest || !latest.context) return
    client.identify(latest.context)
  }, [client, contextKey])

  // --- Suspense gate ---------------------------------------------------
  // A promise tied to the status leaving 'loading'. Suspense hooks throw
  // this rather than `client.onReady()`: it exists before the client does,
  // and it cannot be thrown in a loop after it settles, because by then
  // the status has moved.
  const readyGateRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null)
  if (!readyGateRef.current) {
    let resolveGate: () => void = () => undefined
    const promise = new Promise<void>((resolve) => {
      resolveGate = resolve
    })
    readyGateRef.current = { promise, resolve: resolveGate }
  }
  const readyGate = readyGateRef.current
  useEffect(() => {
    if (statusState.status !== 'loading') readyGate.resolve()
  }, [statusState.status, readyGate])

  // --- Server-evaluated values -----------------------------------------
  const revivedServerFlags = useMemo(() => {
    if (!serverFlags) return null
    return reviveServerFlags(serverFlags)
  }, [serverFlags])

  const value = useMemo<AvsbContextValue>(
    () => ({
      client,
      status: statusState.status,
      error: statusState.error,
      degraded: statusState.degraded,
      serverFlags: revivedServerFlags,
      whenReady: readyGate.promise,
    }),
    [client, statusState, revivedServerFlags, readyGate],
  )

  return <AvsbContext.Provider value={value}>{children}</AvsbContext.Provider>
}
