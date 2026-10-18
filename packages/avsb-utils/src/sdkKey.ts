// =====================================================================
// SDK key shape validation at construction (spec §1.2), shared by every
// JS runtime so all of them say the same thing about the same key.
//
// Real keys are minted by app/_lib/sdkKey.ts as
// `sdk_<environmentKey>_<cuid2>`, where the environment key matches
// /^[a-z][a-z0-9_]*$/ (so it may itself contain underscores, which is why
// this validates with one anchored pattern instead of splitting on '_')
// and the cuid2 is 24 lowercase alphanumerics.
//
// A bad key used to be invisible: the CDN 404s, the datafile fetch returned
// null, and every flag silently served its default. The most common bad
// values are a pasted dashboard URL, a truncated copy, a snippet key, or a
// personal access token pasted into the wrong field, and all four are
// recognisable on sight. So the check names what it got, what the shape is,
// and where the real key lives.
//
// This NEVER throws and never returns early from a constructor. A key we
// cannot recognise may still be valid (the mint format can grow), so an SDK
// logs and proceeds with the value it was given; the datafile fetch is the
// real arbiter.
// =====================================================================

/** Matches `sdk_<envKey>_<id>`; the trailing id segment carries no underscore. */
export const SDK_KEY_PATTERN = /^sdk_[a-z][a-z0-9_]*_[a-z0-9]{8,}$/

/** An example that is real-shaped, so the message is copy-comparable. */
const EXAMPLE_KEY = 'sdk_production_ttqm0eaj4vth1krcb2xn'

export interface SdkKeyShapeResult {
  valid: boolean
  /** Actionable, paste-into-a-support-thread message. Null when valid. */
  message: string | null
}

/**
 * Redact all but the recognisable head of a key so the message can be pasted
 * into a bug report. The environment name is the useful half ("you used the
 * development key"), the cuid2 tail is not.
 */
export function describeSdkKey(sdkKey: string): string {
  if (!sdkKey) return '(empty)'
  if (sdkKey.length <= 12) return sdkKey
  return `${sdkKey.slice(0, 12)}...${sdkKey.slice(-4)}`
}

function diagnose(sdkKey: string): string {
  const trimmed = sdkKey.trim()

  if (!trimmed) {
    return 'no SDK key was passed at all'
  }
  if (trimmed !== sdkKey) {
    return 'it has leading or trailing whitespace, which usually means a copy-paste picked up a line break'
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return 'it looks like a URL, not a key. Copy the key itself, not the address of the page it is on'
  }
  if (trimmed.startsWith('avsb_pat_') || trimmed.startsWith('avsb_svc_')) {
    return 'it looks like a personal access token or a service token. Those talk to the management API; SDKs need the environment SDK key'
  }
  if (trimmed.startsWith('sdk-') || trimmed.startsWith('pub_') || trimmed.startsWith('srv_')) {
    return 'that key prefix has never existed in A vs B. There is one key format for SDKs'
  }
  if (!trimmed.startsWith('sdk_')) {
    return 'it does not start with "sdk_"'
  }
  if (trimmed.split('_').length < 3) {
    return 'it is missing the environment segment, so it may have been truncated'
  }
  return 'the id after the environment name is too short or has characters a generated id never contains, so it may have been truncated or edited'
}

/**
 * Validate the shape of an SDK key. Returns the message to log rather than
 * logging itself, so the caller controls the transport (and so a server SDK
 * and a browser SDK can word the tail of the message identically).
 */
export function validateSdkKeyShape(sdkKey: string): SdkKeyShapeResult {
  if (SDK_KEY_PATTERN.test(sdkKey)) {
    return { valid: true, message: null }
  }

  return {
    valid: false,
    message:
      `AvsB SDK key "${describeSdkKey(sdkKey)}" does not look like an SDK key: ` +
      `${diagnose(sdkKey)}. Keys look like ${EXAMPLE_KEY} (sdk_<environment>_<id>). ` +
      'Copy the key for the environment you want from app.avsb.cloud, then Environments ' +
      'in the project sidebar. The SDK will keep going with the value you passed, so if the ' +
      'datafile request 404s next, this is why.',
  }
}
