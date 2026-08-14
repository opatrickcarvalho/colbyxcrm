import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolvePublicBaseUrl } from '@/lib/http/public-base-url';
import { ensureWebhookRegistered } from '@/lib/whatsapp/uazapi-webhook-sync';

/**
 * GET /api/whatsapp/uazapi/webhook-sync/cron
 *
 * Periodic webhook-subscription health check for EVERY connected UAZAPI
 * account, not just the one currently being paired.
 *
 * `ensureWebhookRegistered()` (uazapi-webhook-sync.ts) previously only
 * ran from `GET /api/whatsapp/uazapi/status`, which is polled by the QR
 * screen while an operator is actively pairing — an account that paired
 * before an event-list change (`WEBHOOK_EVENTS` /
 * `WEBHOOK_EXCLUDE_MESSAGES` in providers/uazapi.ts) has no reason to
 * ever revisit that screen again, so its subscription can drift forever
 * with no error anywhere: inbound messages keep working, but delivery/
 * read ticks silently stop advancing past 'sent'. That is exactly what
 * happened here — see the investigation this route was added to fix.
 *
 * Mirrors the other cron routes (shared `x-cron-secret`,
 * `supabaseAdmin()`), and is meant to be pinged by the same pg_cron job
 * that drains the work queues (migration 056 adds this path to
 * `drain_wacrm_queues()`). `ensureWebhookRegistered` is fingerprint-
 * gated internally, so a steady-state minute-by-minute ping costs one
 * cheap string comparison per connected account, not a re-registration.
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
      'id, uazapi_host, uazapi_instance_token, webhook_secret, uazapi_webhook_registration'
    )
    .eq('provider', 'uazapi')
    .eq('status', 'connected');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!configs || configs.length === 0) {
    return NextResponse.json({ checked: 0, reregistered: 0 });
  }

  const origin = resolvePublicBaseUrl(request, 'uazapi/webhook-sync/cron');
  let reregistered = 0;
  for (const config of configs) {
    const result = await ensureWebhookRegistered(admin, config, origin);
    if (result.reregistered) reregistered++;
  }

  return NextResponse.json({ checked: configs.length, reregistered });
}
