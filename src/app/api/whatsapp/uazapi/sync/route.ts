import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  getInstancePrivacy,
  registerWebhook,
  setInstancePresence,
  setInstancePrivacy,
} from '@/lib/whatsapp/providers';
import { resolvePublicBaseUrl } from '@/lib/http/public-base-url';

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
        'id, provider, uazapi_host, uazapi_instance_token, webhook_secret'
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

    await registerWebhook(
      host,
      token,
      `${origin}/api/whatsapp/uazapi/webhook/${config.webhook_secret}`
    );
    await setInstancePresence(host, token, 'available');

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

    return NextResponse.json({ ok: true, readReceipts: readReceipts ?? null });
  } catch (error) {
    console.error('[uazapi/sync] failed:', error);
    return toErrorResponse(error);
  }
}
