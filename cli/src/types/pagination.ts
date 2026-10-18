/**
 * The cursor block every public-API list response carries
 * (`{ data: [...], page }`). Mirrors `ListPageInfo` in
 * app/_lib/contracts/pagination.ts.
 */
export interface CliListPage {
  /** Pass back as `--cursor` to fetch the next page, or null on the last one. */
  nextCursor: string | null
  hasMore: boolean
}
