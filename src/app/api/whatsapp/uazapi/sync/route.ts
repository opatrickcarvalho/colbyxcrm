import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { registerWebhook, setInstancePresence } from '@/lib/whatsapp/providers';
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

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[uazapi/sync] failed:', error);
    return toErrorResponse(error);
  }
}
