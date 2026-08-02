import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import {
  connectInstance,
  createInstance,
  isUazapiEnabled,
  registerWebhook,
  uazapiHost,
  UazapiNotEnabledError,
} from '@/lib/whatsapp/providers';

/**
 * POST /api/whatsapp/uazapi/connect
 *
 * Starts (or restarts) QR pairing and returns the code to render.
 *
 * Provisioning is folded in on purpose: the customer's mental model is
 * one button ("connect WhatsApp"), and splitting create from connect
 * would leave a half-built row behind whenever someone abandoned the
 * flow between the two calls. So this handler is idempotent — it
 * provisions an instance only when the account has none, and otherwise
 * re-pairs the existing one.
 *
 * The returned QR is valid for two minutes; the client re-POSTs here to
 * refresh it and polls ../status to learn when the scan lands.
 *
 * Requires 'admin': connecting a WhatsApp number is settings-class
 * work, in line with every other write surface in the app.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    if (!isUazapiEnabled()) {
      // The deployment does not offer this provider at all — distinct
      // from the customer having mis-configured theirs, hence 503.
      throw new UazapiNotEnabledError();
    }
    const host = uazapiHost()!;

    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle();

    // Refuse to convert a live Meta connection out from under the
    // operator. Conversations already carry Meta message ids, and those
    // ids mean nothing to uazapi — replies and reactions on existing
    // threads would start failing with no obvious cause. Disconnecting
    // first makes the trade explicit.
    if (existing && existing.provider === 'meta') {
      const { count } = await supabase
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId);

      if ((count ?? 0) > 0) {
        return NextResponse.json(
          {
            error:
              'This account is connected to the official Meta API and already has conversations. Disconnect it first to switch to UAZAPI.',
            code: 'provider_switch_blocked',
          },
          { status: 409 }
        );
      }
    }

    let instanceId = existing?.uazapi_instance_id ?? null;
    let instanceToken = existing?.uazapi_instance_token
      ? decrypt(existing.uazapi_instance_token)
      : null;
    // One secret per account, minted once and reused across reconnects
    // so a refresh does not invalidate the URL uazapi already holds.
    const webhookSecret =
      existing?.webhook_secret ?? randomBytes(32).toString('hex');

    if (!instanceId || !instanceToken) {
      const created = await createInstance(
        accountId,
        `crm-${accountId.slice(0, 8)}`
      );
      instanceId = created.id;
      instanceToken = created.token;
    }

    // Register the callback before pairing: messages can start arriving
    // the moment the scan completes, and a webhook registered after
    // that races the first inbound message.
    const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim();
    const origin = configuredOrigin
      ? configuredOrigin.replace(/\/+$/, '')
      : new URL(request.url).origin;

    await registerWebhook(
      host,
      instanceToken,
      `${origin}/api/whatsapp/uazapi/webhook/${webhookSecret}`
    );

    const connected = await connectInstance(host, instanceToken);

    const { error: upsertError } = await supabase
      .from('whatsapp_config')
      .upsert(
        {
          account_id: accountId,
          // NOT NULL since migration 001. Tenancy runs off `account_id`
          // (migration 017) — this column is the audit trail of which
          // member last wired the connection up, so it tracks whoever
          // ran this connect rather than being preserved from the row
          // that was there before.
          user_id: userId,
          provider: 'uazapi',
          uazapi_host: host,
          uazapi_instance_id: instanceId,
          uazapi_instance_token: encrypt(instanceToken),
          webhook_secret: webhookSecret,
          status: connected.status === 'connected' ? 'connected' : 'connecting',
          // Meta columns stay NULL — the conditional CHECK in migration
          // 038 is what allows that for a uazapi row.
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'account_id' }
      );

    if (upsertError) {
      console.error(
        '[uazapi/connect] config upsert failed:',
        upsertError.message
      );
      return NextResponse.json(
        {
          error: `Instance paired but saving it failed: ${upsertError.message}`,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      status: connected.status,
      // Base64 PNG. Absent once the instance is already connected.
      qrcode: connected.qrcode ?? null,
      paircode: connected.paircode ?? null,
      /** Seconds the code stays scannable — drives the client refresh. */
      expires_in: 120,
    });
  } catch (error) {
    if (error instanceof UazapiNotEnabledError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    console.error('Error in uazapi connect POST:', error);
    return toErrorResponse(error);
  }
}
