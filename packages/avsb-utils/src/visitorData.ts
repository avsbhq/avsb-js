// Visitor-data typed instances — Browser, Device, Geolocation, PageView.
// Each returns a `SingleContext` populated from caller-supplied data (or
// inferred from the runtime environment when possible). The returned
// context is intended to be combined into a multi-context via
// `ContextBuilder.setKind(kind, key, attrs)`.
//
// Spec §6.1 lists this file. Kameleoon-style: deterministic shapes a
// platform-rule author can target without guessing.

import type { SingleContext } from '@avsbhq/core'

export interface BrowserOpts {
  userAgent?: string
  language?: string
  timezone?: string
  viewportWidth?: number
  viewportHeight?: number
}

export function Browser(opts: BrowserOpts = {}): SingleContext {
  const nav = (
    globalThis as { navigator?: { userAgent?: string; language?: string } }
  ).navigator
  const win = (
    globalThis as {
      innerWidth?: number
      innerHeight?: number
      Intl?: {
        DateTimeFormat?: () => { resolvedOptions: () => { timeZone: string } }
      }
    }
  )
  const ua = opts.userAgent ?? nav?.userAgent ?? ''
  const language = opts.language ?? nav?.language ?? ''
  const timezone =
    opts.timezone ??
    win.Intl?.DateTimeFormat?.().resolvedOptions().timeZone ??
    ''
  return {
    kind: 'browser',
    key: ua || 'unknown',
    userAgent: ua,
    language,
    timezone,
    viewportWidth: opts.viewportWidth ?? win.innerWidth ?? 0,
    viewportHeight: opts.viewportHeight ?? win.innerHeight ?? 0,
  }
}

export interface DeviceOpts {
  id?: string
  os?: string
  osVersion?: string
  type?: 'mobile' | 'tablet' | 'desktop'
  model?: string
}

export function Device(opts: DeviceOpts = {}): SingleContext {
  return {
    kind: 'device',
    key: opts.id ?? 'unknown',
    os: opts.os ?? '',
    osVersion: opts.osVersion ?? '',
    type: opts.type ?? 'desktop',
    model: opts.model ?? '',
  }
}

export interface GeoOpts {
  country?: string
  region?: string
  city?: string
  latitude?: number
  longitude?: number
}

export function Geolocation(opts: GeoOpts = {}): SingleContext {
  return {
    kind: 'geo',
    key: `${opts.country ?? ''}/${opts.region ?? ''}/${opts.city ?? ''}`,
    country: opts.country ?? '',
    region: opts.region ?? '',
    city: opts.city ?? '',
    latitude: opts.latitude ?? null,
    longitude: opts.longitude ?? null,
  }
}

export interface PageOpts {
  url?: string
  path?: string
  referrer?: string
  title?: string
}

export function PageView(opts: PageOpts = {}): SingleContext {
  const loc = (globalThis as { location?: { href: string; pathname: string } })
    .location
  const doc = (
    globalThis as { document?: { referrer: string; title: string } }
  ).document
  const url = opts.url ?? loc?.href ?? ''
  return {
    kind: 'page',
    key: url || 'unknown',
    url,
    path: opts.path ?? loc?.pathname ?? '',
    referrer: opts.referrer ?? doc?.referrer ?? '',
    title: opts.title ?? doc?.title ?? '',
  }
}
