import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { resolvePublicBaseUrl } from '@/lib/http/public-base-url';
import { decrypt } from '@/lib/whatsapp/encryption';
import { jidToPhone } from '@/lib/whatsapp/phone-utils';
import { instanceStatus } from '@/lib/whatsapp/providers';
import { ensureWebhookRegistered } from '@/lib/whatsapp/uazapi-webhook-sync';

/**
 * GET /api/whatsapp/uazapi/status
 *
 * Polled by the QR screen while the operator scans. Asks uazapi for the
 * live instance state and mirrors it onto `whatsapp_config.status`, so
 * the rest of the app (settings overview, inbox banner) can read the
 * connection state straight from the database without every reader
 * having to call uazapi itself.
 *
 * It is also where the webhook subscription heals. That is not an
 * arbitrary home for it: this is the one endpoint that runs regularly
 * against a live instance, and the subscription is remote state that
 * pairing alone cannot keep current. See uazapi-webhook-sync.ts.
 *
 * 'agent' rather than 'admin': this only reads state, and the inbox
 * needs it too.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent');

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle();

    if (!config || config.provider !== 'uazapi') {
      return NextResponse.json(
        { error: 'This account is not connected through UAZAPI.' },
        { status: 400 }
      );
    }

    if (!config.uazapi_host || !config.uazapi_instance_token) {
      return NextResponse.json({ status: 'disconnected', connected: false });
    }

    const instance = await instanceStatus(
      config.uazapi_host,
      decrypt(config.uazapi_instance_token)
    );

    // The connected number (needed by the /l/{code} ad-attribution
    // redirect, 069_whatsapp_config_connected_number.sql) — parsed once
    // it's actually known, kept once set.
    const connectedNumber = instance.owner
      ? jidToPhone(instance.owner)?.replace(/\D/g, '')
      : undefined;

    // Mirror uazapi's state locally. The status/connected_at write is
    // gated on an actual status change — this endpoint is polled every
    // couple of seconds during pairing and an unconditional UPDATE would
    // churn the row (and its updated_at) for no reason. connected_number
    // is gated separately: an already-connected account's status never
    // changes again on later polls, so without its own check it would
    // never get backfilled.
    const statusChanged = instance.status !== config.status;
    const numberNewlyKnown = Boolean(
      connectedNumber && connectedNumber !== config.connected_number
    );
    if (statusChanged || numberNewlyKnown) {
      await supabase
        .from('whatsapp_config')
        .update({
          status: instance.status,
          connected_at:
            instance.status === 'connected'
              ? new Date().toISOString()
              : config.connected_at,
          ...(numberNewlyKnown ? { connected_number: connectedNumber } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', config.id);
    }

    // Reconcile the webhook subscription once the instance is actually
    // live. Gated on `connected` because uazapi rejects webhook writes
    // for an instance that has not paired yet, and gated internally on a
    // fingerprint, so the steady-state poll costs nothing extra.
    let webhookReregistered = false;
    if (instance.status === 'connected') {
      const sync = await ensureWebhookRegistered(
        supabase,
        config,
        resolvePublicBaseUrl(request, 'uazapi/status')
      );
      webhookReregistered = sync.reregistered;
    }

    return NextResponse.json({
      status: instance.status,
      connected: instance.status === 'connected',
      profile_name: instance.profileName ?? null,
      /** True when this poll repaired an out-of-date event subscription. */
      webhook_reregistered: webhookReregistered,
    });
  } catch (error) {
    console.error('Error in uazapi status GET:', error);
    return toErrorResponse(error);
  }
}
