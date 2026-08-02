import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { instanceStatus } from '@/lib/whatsapp/providers';

/**
 * GET /api/whatsapp/uazapi/status
 *
 * Polled by the QR screen while the operator scans. Asks uazapi for the
 * live instance state and mirrors it onto `whatsapp_config.status`, so
 * the rest of the app (settings overview, inbox banner) can read the
 * connection state straight from the database without every reader
 * having to call uazapi itself.
 *
 * 'agent' rather than 'admin': this only reads state, and the inbox
 * needs it too.
 */
export async function GET() {
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

    // Mirror uazapi's state locally. Only write when it actually moved —
    // this endpoint is polled every couple of seconds during pairing and
    // an unconditional UPDATE would churn the row (and its updated_at)
    // for no reason.
    if (instance.status !== config.status) {
      await supabase
        .from('whatsapp_config')
        .update({
          status: instance.status,
          connected_at:
            instance.status === 'connected'
              ? new Date().toISOString()
              : config.connected_at,
          updated_at: new Date().toISOString(),
        })
        .eq('id', config.id);
    }

    return NextResponse.json({
      status: instance.status,
      connected: instance.status === 'connected',
      profile_name: instance.profileName ?? null,
    });
  } catch (error) {
    console.error('Error in uazapi status GET:', error);
    return toErrorResponse(error);
  }
}
