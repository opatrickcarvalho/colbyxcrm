// ============================================================
// Keep uazapi's webhook subscription in step with the code.
//
// The subscription is remote state. `registerWebhook()` used to be
// called from exactly one place — the pairing flow — which quietly made
// "the events list in the source" and "the events list uazapi holds"
// two different things that only agreed at the moment someone scanned a
// QR code. They drifted the first time the list grew, and the symptom
// was invisible: inbound messages kept working (that event was in the
// old list), while delivery ticks and presence simply never arrived,
// with no error anywhere to suggest why.
//
// So reconciliation does not belong in the pairing flow. It belongs on
// the paths that run repeatedly against a live instance — the status
// poll and the manual sync — which is what this module gives them.
//
// It is fingerprint-gated rather than time-gated on purpose. The status
// endpoint is polled every couple of seconds during pairing; a
// time-based check would either re-register constantly or leave a long
// window where a freshly deployed event list is not live yet. Comparing
// a fingerprint means exactly one extra call per instance per change to
// the registration, and none at all in the steady state.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import {
  registerWebhook,
  webhookRegistrationFingerprint,
} from '@/lib/whatsapp/providers';

/** The `whatsapp_config` columns this needs. */
export interface WebhookSyncConfigRow {
  id: string;
  uazapi_host: string | null;
  uazapi_instance_token: string | null;
  webhook_secret: string | null;
  uazapi_webhook_registration?: string | null;
}

export interface WebhookSyncResult {
  /** True when this call actually pushed a new registration. */
  reregistered: boolean;
  /** Why it did nothing, for logging. Absent when it acted. */
  skipped?: 'missing_credentials' | 'already_current' | 'failed';
}

/** The callback URL uazapi should be posting to for this config row. */
export function webhookCallbackUrl(origin: string, secret: string): string {
  return `${origin}/api/whatsapp/uazapi/webhook/${secret}`;
}

/**
 * Re-push the webhook registration if the one uazapi holds predates the
 * current event list. No-op when the stored fingerprint already matches.
 *
 * Never throws. A failure to reach uazapi must not take down a status
 * poll or a contact sync — those have their own jobs, and the next poll
 * retries this one anyway. The fingerprint is written only after a
 * successful push, so a failure leaves the row eligible to retry rather
 * than marking it done.
 */
export async function ensureWebhookRegistered(
  db: SupabaseClient,
  config: WebhookSyncConfigRow,
  origin: string
): Promise<WebhookSyncResult> {
  if (
    !config.uazapi_host ||
    !config.uazapi_instance_token ||
    !config.webhook_secret
  ) {
    return { reregistered: false, skipped: 'missing_credentials' };
  }

  const url = webhookCallbackUrl(origin, config.webhook_secret);
  const fingerprint = webhookRegistrationFingerprint(url);

  if (config.uazapi_webhook_registration === fingerprint) {
    return { reregistered: false, skipped: 'already_current' };
  }

  try {
    await registerWebhook(
      config.uazapi_host,
      decrypt(config.uazapi_instance_token),
      url
    );
  } catch (err) {
    console.error(
      '[uazapi/webhook-sync] re-registration failed:',
      err instanceof Error ? err.message : err
    );
    return { reregistered: false, skipped: 'failed' };
  }

  const { error } = await db
    .from('whatsapp_config')
    .update({ uazapi_webhook_registration: fingerprint })
    .eq('id', config.id);

  if (error) {
    // The registration DID land; only the bookkeeping failed. Report it
    // as re-registered rather than as a no-op — the worst case is that
    // the next poll pushes an identical registration, which is harmless.
    console.error(
      '[uazapi/webhook-sync] registered, but storing the fingerprint failed:',
      error.message
    );
  } else {
    console.log(
      `[uazapi/webhook-sync] re-registered webhook for config ${config.id}`
    );
  }

  return { reregistered: true };
}
