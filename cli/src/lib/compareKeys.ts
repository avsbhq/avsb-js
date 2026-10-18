/**
 * One sort order for every generated artifact.
 *
 * `String.prototype.localeCompare` asks ICU, and ICU answers differently
 * depending on the locale the process happens to be running in: a laptop on
 * `en-US` and a CI container on `POSIX` disagree about where `_` sorts against
 * letters, and about case. For a file that `avsb codegen --check` compares byte
 * for byte, that is phantom drift: the build fails, the developer regenerates,
 * nothing changes, and the next CI run fails again.
 *
 * Code-unit order has no such opinion. It is what a bare `Array.prototype.sort`
 * already uses, so this comparator simply makes the choice explicit everywhere
 * a comparator is written out by hand.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
