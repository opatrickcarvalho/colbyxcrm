import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';

/**
 * POST /api/admin/accounts/[id]/suspend
 *
 * Body: { reason?: string }
 *
 * Flips `accounts.status` to 'suspended'. From that moment, the RLS
 * suspension gate (migration 040's `is_account_member`) blocks every
 * tenant table for every member of this account, and
 * `getCurrentAccount()`/`requireApiKey()` reject with a friendly
 * `account_suspended` error on top of that.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId: adminUserId } = await requirePlatformAdmin();
    const { id } = await params;
    const db = supabaseAdmin();

    const body = await request.json().catch(() => ({}));
    const reason =
      typeof body?.reason === 'string' && body.reason.trim()
        ? body.reason.trim().slice(0, 500)
        : null;

    const { data: account, error: fetchErr } = await db
      .from('accounts')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr || !account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    if (account.status === 'suspended') {
      return NextResponse.json({ error: 'Account is already suspended' }, { status: 400 });
    }

    const { error: updateErr } = await db
      .from('accounts')
      .update({
        status: 'suspended',
        suspended_at: new Date().toISOString(),
        suspended_reason: reason,
      })
      .eq('id', id);

    if (updateErr) {
      console.error('[admin/accounts/:id/suspend] update error:', updateErr);
      return NextResponse.json(
        { error: 'Failed to suspend account' },
        { status: 500 }
      );
    }

    await db.from('admin_audit_log').insert({
      admin_user_id: adminUserId,
      action: 'account_suspended',
      target_account_id: id,
      metadata: { reason },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
