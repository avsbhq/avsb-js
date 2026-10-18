/**
 * Platform endpoints behind `avsb listen` and `avsb trigger`.
 *
 * Split out of `api.ts` to keep that file under the size limit. It extends
 * `ApiClient` rather than re-implementing a client, so the token precedence
 * (`AVSB_TOKEN` over the saved login), the base-URL precedence, and the
 * two-shaped error envelope are shared, not copied. `ApiClient`'s own public
 * surface is untouched: a command that needs both simply constructs this one.
 */

import { ApiClient } from './api.js'
import type {
  ApiWebhookEventListResponse,
  ApiWebhookRelayTicketResponse,
  ApiWebhookTriggerResponse,
} from './webhookRelay.js'

export class WebhookApiClient extends ApiClient {
  /**
   * Mint a ticket for this project's webhook relay channel.
   *
   * The ticket is spent against the stream worker, which `avsb listen` connects
   * to directly. The token travels in the query string because an SSE
   * connection cannot carry an Authorization header through every proxy.
   */
  async getWebhookRelayTicket(projectShortId: number): Promise<ApiWebhookRelayTicketResponse> {
    return this.request<ApiWebhookRelayTicketResponse>(
      `/api/cli/projects/${projectShortId}/webhooks/relay-ticket`,
    )
  }

  /** The event names `avsb trigger` accepts, straight from the platform catalog. */
  async listWebhookEvents(projectShortId: number): Promise<ApiWebhookEventListResponse> {
    return this.request<ApiWebhookEventListResponse>(
      `/api/cli/projects/${projectShortId}/webhooks/trigger`,
    )
  }

  /** Send a sample payload for one event to the project's webhooks. */
  async triggerWebhookEvent(
    projectShortId: number,
    body: { event: string; webhookId?: string },
  ): Promise<ApiWebhookTriggerResponse> {
    return this.request<ApiWebhookTriggerResponse>(
      `/api/cli/projects/${projectShortId}/webhooks/trigger`,
      { method: 'POST', body: JSON.stringify(body) },
    )
  }
}
