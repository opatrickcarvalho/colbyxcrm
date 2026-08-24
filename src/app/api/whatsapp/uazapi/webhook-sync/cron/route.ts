import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { jidToPhone } from '@/lib/whatsapp/phone-utils';
import { resolvePublicBaseUrl } from '@/lib/http/public-base-url';
import { ensureWebhookRegistered } from '@/lib/whatsapp/uazapi-webhook-sync';
import {
  getInstancePrivacy,
  instanceStatus,
  setInstancePresence,
} from '@/lib/whatsapp/providers';

/**
 * GET /api/whatsapp/uazapi/webhook-sync/cron
 *
 * Periodic health check for EVERY connected UAZAPI account, not just
 * the one currently being paired, covering the two independent ways
 * delivery/read ticks (`messages_update` webhooks) silently stop:
 *
 *   1. Webhook subscription drift — `ensureWebhookRegistered()`
 *      (uazapi-webhook-sync.ts) previously only ran from `GET
 *      /api/whatsapp/uazapi/status`, which is polled by the QR screen
 *      while an operator is actively pairing. An account that paired
 *      before an event-list change never revisits that screen, so its
 *      subscription can drift forever with no error anywhere: inbound
 *      messages keep working, but ticks stop advancing past 'sent'.
 *   2. Presence — per `setInstancePresence`'s own doc comment
 *      (providers/uazapi.ts), when the instance is the only active
 *      device and its presence is 'unavailable', `messages_update`
 *      webhooks stop being sent OR received entirely — not a
 *      subscription problem at all, WhatsApp just doesn't emit them.
 *      It's normally set once right after pairing; re-asserting
 *      'available' every run is a cheap, idempotent guard against it
 *      drifting back (phone battery saver, WhatsApp itself flipping
 *      it) with no code-visible symptom besides ticks going quiet.
 *      Confirmed against live data as the actual cause here: fixing
 *      (1) alone left every one of 1,511 outbound messages still at
 *      delivered_at/read_at = null.
 *
 * `readreceipts` (also read here, logged only) is a THIRD, separate
 * failure mode this cannot fix: WhatsApp's read receipts are
 * reciprocal, so an account with them turned off in its own privacy
 * settings never gets ticks past 'delivered' no matter how healthy
 * the webhook/presence side is. `setInstancePrivacy` is explicitly
 * gated on an explicit user action elsewhere in this codebase — it
 * must never be flipped silently — so this only surfaces the value
 * for a human to check, it does not change it.
 *
 * Also backfills `whatsapp_config.connected_number` (069) when missing —
 * needed by the /l/{code} ad-attribution redirect. `GET
 * /api/whatsapp/uazapi/status` sets it too, but that route is only
 * polled by the QR screen during pairing; an account connected before
 * this column existed would otherwise never revisit that screen and
 * stay unbackfilled forever. This is the one path that already runs
 * regularly against every connected account regardless.
 *
 * Mirrors the other cron routes (shared `x-cron-secret`,
 * `supabaseAdmin()`), and is meant to be pinged by the same pg_cron job
 * that drains the work queues (migration 056 adds this path to
 * `drain_wacrm_queues()`).
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const { data: configs, error } = await admin
    .from('whatsapp_config')
    .select(
      'id, uazapi_host, uazapi_instance_token, webhook_secret, uazapi_webhook_registration, connected_number'
    )
    .eq('provider', 'uazapi')
    .eq('status', 'connected');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!configs || configs.length === 0) {
    return NextResponse.json({ checked: 0, reregistered: 0, presenceFixed: 0 });
  }

  const origin = resolvePublicBaseUrl(request, 'uazapi/webhook-sync/cron');
  let reregistered = 0;
  let presenceFixed = 0;
  const readReceipts: Record<string, string | undefined> = {};

  for (const config of configs) {
    const webhookResult = await ensureWebhookRegistered(admin, config, origin);
    if (webhookResult.reregistered) reregistered++;

    if (!config.uazapi_host || !config.uazapi_instance_token) continue;
    try {
      const token = decrypt(config.uazapi_instance_token);
      // Idempotent and cheap — see the doc comment above for why this
      // runs unconditionally on every tick rather than being fingerprint-
      // gated like the webhook registration.
      await setInstancePresence(config.uazapi_host, token, 'available');
      presenceFixed++;

      const privacy = await getInstancePrivacy(config.uazapi_host, token);
      readReceipts[config.id] = privacy.readreceipts;

      if (!config.connected_number) {
        const instance = await instanceStatus(config.uazapi_host, token);
        const connectedNumber = instance.owner
          ? jidToPhone(instance.owner)?.replace(/\D/g, '')
          : undefined;
        if (connectedNumber) {
          await admin
            .from('whatsapp_config')
            .update({ connected_number: connectedNumber })
            .eq('id', config.id);
        }
      }
    } catch (err) {
      console.error(
        '[uazapi/webhook-sync/cron] presence/privacy check failed:',
        config.id,
        err instanceof Error ? err.message : err
      );
    }
  }

  return NextResponse.json({
    checked: configs.length,
    reregistered,
    presenceFixed,
    readReceipts,
  });
}
