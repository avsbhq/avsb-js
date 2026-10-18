/**
 * The datafile read `avsb codegen` uses, in the two shapes it needs.
 *
 * `ApiClient.getDatafile` answers the one-shot case and stays exactly as it
 * was. Watch mode needs the second shape: a poll that can come back "nothing
 * changed" without re-downloading the file or throwing.
 *
 * Kept in its own file rather than added to `api.ts`, which is at its size
 * limit, and because the conditional read exists for this command alone.
 */

import { ApiClient } from './api.js'
import type { ConditionalResult } from './apiTransport.js'
import type { CodegenDatafile } from './codegenEmit.js'

export class CodegenApiClient extends ApiClient {
  /**
   * Fetch the datafile, sending `If-None-Match` when a previous read gave us an
   * ETag.
   *
   * The `/api/cli` datafile route does not send an ETag today, so in practice
   * the answer is always `ok` and watch mode decides "changed or not" by
   * comparing what it generated. That is deliberate: the moment the route
   * starts sending one, every poll after the first costs a 304 instead of a
   * datafile, with no CLI change and no version negotiation.
   */
  async getDatafileConditional(
    projectShortId: number,
    environment: string,
    etag: string | null,
  ): Promise<ConditionalResult<CodegenDatafile>> {
    return this.requestIfNoneMatch<CodegenDatafile>(
      `/api/cli/projects/${projectShortId}/datafile?env=${encodeURIComponent(environment)}`,
      etag,
    )
  }
}
