import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { cancelAsaasSubscription } from '@/lib/billing/asaas/api';

// Owner-only, same reasoning as /api/billing/subscribe: cancelling
// touches the account's billing relationship, not a single agent's
// work. Deliberately does NOT touch accounts.plan_expires_at — the
// customer keeps the window they already paid for (see
// cancelAsaasSubscription's doc comment).
export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('owner', { allowUnentitled: true });

    const body = await request.json().catch(() => ({}));
    const { subscriptionId } = body as { subscriptionId?: unknown };
    if (typeof subscriptionId !== 'string' || !subscriptionId) {
      return NextResponse.json(
        { error: 'subscriptionId is required' },
        { status: 400 }
      );
    }

    const admin = supabaseAdmin();
    const { data: row, error } = await admin
      .from('account_subscriptions')
      .select('id, account_id, asaas_subscription_id, status')
      .eq('id', subscriptionId)
      .maybeSingle();

    if (error || !row || row.account_id !== accountId) {
      return NextResponse.json(
        { error: 'Subscription not found' },
        { status: 404 }
      );
    }
    if (!['pending', 'active', 'past_due'].includes(row.status as string)) {
      return NextResponse.json(
        { error: 'Subscription is already cancelled' },
        { status: 400 }
      );
    }

    if (row.asaas_subscription_id) {
      // Best-effort: if Asaas already deleted it (e.g. from their own
      // dashboard) this 404s upstream — don't let that block marking
      // our own row cancelled.
      await cancelAsaasSubscription(row.asaas_subscription_id as string).catch(
        (err) =>
          console.error(
            '[POST /api/billing/cancel] cancelAsaasSubscription:',
            err
          )
      );
    }

    await admin
      .from('account_subscriptions')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', row.id);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
