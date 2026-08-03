import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';

/**
 * POST /api/admin/accounts/[id]/reactivate
 *
 * Clears the suspension — flips `accounts.status` back to 'active'
 * and blanks `suspended_at`/`suspended_reason`. Access resumes
 * immediately (same RLS gate as suspend, just the other direction).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId: adminUserId } = await requirePlatformAdmin();
    const { id } = await params;
    const db = supabaseAdmin();

    const { data: account, error: fetchErr } = await db
      .from('accounts')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr || !account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    if (account.status !== 'suspended') {
      return NextResponse.json({ error: 'Account is not suspended' }, { status: 400 });
    }

    const { error: updateErr } = await db
      .from('accounts')
      .update({
        status: 'active',
        suspended_at: null,
        suspended_reason: null,
      })
      .eq('id', id);

    if (updateErr) {
      console.error('[admin/accounts/:id/reactivate] update error:', updateErr);
      return NextResponse.json(
        { error: 'Failed to reactivate account' },
        { status: 500 }
      );
    }

    await db.from('admin_audit_log').insert({
      admin_user_id: adminUserId,
      action: 'account_reactivated',
      target_account_id: id,
      metadata: {},
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
