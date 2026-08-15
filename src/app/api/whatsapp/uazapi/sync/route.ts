import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  getInstancePrivacy,
  getWebhookErrors,
  missingWebhookEvents,
  readWebhooks,
  registerWebhook,
  setInstancePresence,
  setInstancePrivacy,
  webhookRegistrationFingerprint,
} from '@/lib/whatsapp/providers';
import { resolvePublicBaseUrl } from '@/lib/http/public-base-url';
import { webhookCallbackUrl } from '@/lib/whatsapp/uazapi-webhook-sync';

/**
 * POST /api/whatsapp/uazapi/sync
 *
 * Re-applies two things `connect/route.ts` only does at PAIRING time —
 * `registerWebhook` (event list) and `setInstancePresence('available')`
 * — to an ALREADY-connected instance, without a new QR scan.
 *
 * Why this route exists: connect/route.ts's webhook registration and
 * presence call only run once, at pairing. Any account that connected
 * before those two behaviors were added (event list gained
 * presence/labels/chat_labels; presence gained the 'available' call)
 * never got them — its uazapi webhook subscription is still the old,
 * narrower list, and its instance may still be sitting at
 * presence=unavailable, which per uazapi's docs silently stops
 * messages_update (delivery/read tick) webhooks from arriving at all.
 * This is the one-click fix for that, short of a full reconnect.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');

    // `{ enable_read_receipts: true }` opts into flipping the paired
    // account's `readreceipts` privacy setting to "all". Deliberately
    // opt-in: WhatsApp read receipts are reciprocal, so turning them on
    // also means this number starts sending blue ticks to everyone it
    // talks to — a change to the operator's own WhatsApp behaviour that
    // must never happen as a side effect of a "sync" button.
    const body = (await request.json().catch(() => null)) as {
      enable_read_receipts?: boolean;
    } | null;

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select(
        'id, provider, uazapi_host, uazapi_instance_token, webhook_secret, uazapi_webhook_registration'
      )
      .eq('account_id', accountId)
      .maybeSingle();

    if (
      !config ||
      config.provider !== 'uazapi' ||
      !config.uazapi_host ||
      !config.uazapi_instance_token ||
      !config.webhook_secret
    ) {
      return NextResponse.json(
        { error: 'This account has no active UAZAPI connection.' },
        { status: 400 }
      );
    }

    const host = config.uazapi_host as string;
    const token = decrypt(config.uazapi_instance_token as string);
    const origin = resolvePublicBaseUrl(request, 'uazapi/sync');

    const webhookUrl = webhookCallbackUrl(
      origin,
      config.webhook_secret as string
    );
    await registerWebhook(host, token, webhookUrl);
    // Record what we just pushed so the status poll's reconciler agrees
    // this instance is current instead of pushing it a second time.
    await supabase
      .from('whatsapp_config')
      .update({
        uazapi_webhook_registration: webhookRegistrationFingerprint(webhookUrl),
      })
      .eq('id', config.id);
    await setInstancePresence(host, token, 'available');

    // Read the subscription back rather than trusting the write. This is
    // the diagnostic that was missing when delivery ticks stopped: the
    // registration is remote state, and "we called registerWebhook" is
    // not evidence that uazapi is subscribed to what we think it is.
    // Anything listed here explains a handler that never fires.
    let webhookEventsMissing: string[] = [];
    try {
      webhookEventsMissing = missingWebhookEvents(
        await readWebhooks(host, token),
        webhookUrl
      );
      if (webhookEventsMissing.length > 0) {
        console.warn(
          '[uazapi/sync] uazapi is not subscribed to:',
          webhookEventsMissing.join(', ')
        );
      }
    } catch (err) {
      console.error(
        '[uazapi/sync] could not read back the webhook registration:',
        err instanceof Error ? err.message : err
      );
    }

    // Diagnose (and only on explicit request, fix) the reciprocal
    // read-receipt setting — the usual reason ticks sit at "delivered"
    // forever while delivery itself works fine.
    let readReceipts: string | undefined;
    try {
      if (body?.enable_read_receipts) {
        await setInstancePrivacy(host, token, { readreceipts: 'all' });
      }
      readReceipts = (await getInstancePrivacy(host, token)).readreceipts;
    } catch (err) {
      // Privacy is a diagnostic extra; never fail the sync over it.
      console.error(
        '[uazapi/sync] could not read privacy settings:',
        err instanceof Error ? err.message : err
      );
    }

    // uazapi's own record of failed deliveries to our callback URL —
    // the missing half of the picture when `webhook_events_missing` is
    // empty (subscription looks correct) but ticks still never arrive.
    // An empty array here is NOT proof nothing ever failed: the log is
    // memory-only on uazapi's side and resets on their process restart,
    // so it only covers "recently."
    let webhookErrors: Awaited<ReturnType<typeof getWebhookErrors>> = [];
    try {
      webhookErrors = await getWebhookErrors(host, token);
    } catch (err) {
      console.error(
        '[uazapi/sync] could not read webhook error log:',
        err instanceof Error ? err.message : err
      );
    }

    return NextResponse.json({
      ok: true,
      readReceipts: readReceipts ?? null,
      /**
       * Subscribed events we expect but uazapi does not report holding.
       * Empty is the healthy case; non-empty names exactly which webhook
       * handlers will stay silent.
       */
      webhook_events_missing: webhookEventsMissing,
      /**
       * uazapi's last-20 delivery-failure log for this instance's local
       * webhook. Non-empty means uazapi IS attempting deliveries and
       * they're failing (timeout, non-2xx, connection refused) — check
       * `status_code`/`error` on each entry. Empty means either nothing
       * failed recently, or (see webhook_events_missing) uazapi isn't
       * attempting the send at all.
       */
      webhook_errors: webhookErrors,
    });
  } catch (error) {
    console.error('[uazapi/sync] failed:', error);
    return toErrorResponse(error);
  }
}
