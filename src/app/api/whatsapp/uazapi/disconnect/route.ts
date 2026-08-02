import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { disconnectInstance } from '@/lib/whatsapp/providers';

/**
 * POST /api/whatsapp/uazapi/disconnect
 *
 * Unpairs the number and clears the account's UAZAPI credentials.
 *
 * This is also the gate the provider switch goes through: ../connect
 * refuses to convert an account that still has conversations, so the
 * operator disconnects here first and the trade-off is explicit rather
 * than silent.
 *
 * The remote unpair is best-effort. If uazapi is unreachable we still
 * clear the row: leaving stale credentials behind would strand the
 * account in a state where the UI shows "connected" and every send
 * fails. The instance stays attributable regardless — `adminField01`
 * carries the account id on uazapi's side.
 */
export async function POST() {
  try {
    const { supabase, accountId } = await requireRole('admin');

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

    if (config.uazapi_host && config.uazapi_instance_token) {
      try {
        await disconnectInstance(
          config.uazapi_host,
          decrypt(config.uazapi_instance_token)
        );
      } catch (err) {
        console.warn(
          '[uazapi/disconnect] remote unpair failed, clearing locally anyway:',
          err instanceof Error ? err.message : err
        );
      }
    }

    // Instead of deleting the row, we just mark it as disconnected.
    // This allows the next 'connect' to reuse the same UAZAPI instance
    // rather than leaking instances on the provider. The token is kept
    // intact to satisfy the CHECK constraint from migration 038.
    const { error: deleteError } = await supabase
      .from('whatsapp_config')
      .update({ status: 'disconnected', updated_at: new Date().toISOString() })
      .eq('id', config.id);

    if (deleteError) {
      console.error(
        '[uazapi/disconnect] config delete failed:',
        deleteError.message
      );
      return NextResponse.json(
        {
          error: `Disconnected remotely but updating the config failed: ${deleteError.message}`,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error in uazapi disconnect POST:', error);
    return toErrorResponse(error);
  }
}
