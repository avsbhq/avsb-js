import {
  computed,
  onScopeDispose,
  shallowRef,
  type ComputedRef,
} from 'vue'
import type { Flag } from '@avsbhq/core'
import { useAvsbContext } from '../context'

/**
 * Every flag in the environment, keyed by flag key.
 *
 * Re-computes on any flag change, so prefer `useFlag` in components that
 * read one flag. This is for debug panels and admin views.
 *
 * Exposures are suppressed, and the SDK returns the same object between
 * changes, so this is safe to read on every render. Before the SDK is ready
 * it is `{}` and the SDK logs one line saying why, rather than looking like
 * a project with no flags.
 */
export function useAllFlags(): ComputedRef<Record<string, Flag>> {
  const { client } = useAvsbContext()

  const current = shallowRef<Record<string, Flag>>(client.getAllFlags())

  const unsubscribe = client.on('flagChange', () => {
    current.value = client.getAllFlags()
  })

  onScopeDispose(unsubscribe)

  return computed(() => current.value)
}
