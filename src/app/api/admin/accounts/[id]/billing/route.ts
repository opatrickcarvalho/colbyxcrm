import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { getBillingSettings } from '@/lib/billing/platform-settings';
import { invalidateEntitlement } from '@/lib/billing/guard';

interface UpdateBody {
  billingExempt?: unknown;
}

/**
 * PATCH /api/admin/accounts/[id]/billing
 *
 * The manual toggle migration 053's own comment promised would live
 * "from /admin/accounts/<id>" but never actually got built — every
 * account that existed when 053 ran was grandfathered permanently
 * exempt, and until this route existed the only way to un-grandfather
 * one was the hand-run SQL snippet in that migration's file.
 *
 * Turning exemption OFF mirrors that snippet exactly: it starts a
 * fresh trial window (`billing_status: 'trialing'`, both horizon
 * columns set to now + the platform's configured trial_days) rather
 * than leaving `plan_expires_at` at whatever value migration 053's
 * ALTER TABLE happened to backfill it to — that value is a one-time
 * artifact of when the migration ran, not a real trial anyone agreed to.
 *
 * Turning it back ON is the safe direction (grants access unconditionally)
 * and needs no such care.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requirePlatformAdmin();
    const { id } = await params;

    const body = (await request.json().catch(() => ({}))) as UpdateBody;
    const { billingExempt } = body;

    if (typeof billingExempt !== 'boolean') {
      return NextResponse.json(
        { error: 'billingExempt must be a boolean' },
        { status: 400 }
      );
    }

    const db = supabaseAdmin();

    const patch: Record<string, unknown> = billingExempt
      ? { billing_exempt: true, billing_status: 'exempt' }
      : await (async () => {
          const { trialDays } = await getBillingSettings();
          const horizon = new Date(
            Date.now() + trialDays * 24 * 60 * 60 * 1000
          ).toISOString();
          return {
            billing_exempt: false,
            billing_status: 'trialing',
            trial_ends_at: horizon,
            plan_expires_at: horizon,
          };
        })();

    const { data, error } = await db
      .from('accounts')
      .update(patch)
      .eq('id', id)
      .select(
        'id, billing_status, plan_expires_at, trial_ends_at, billing_exempt'
      )
      .maybeSingle();

    if (error) {
      console.error(
        '[PATCH /api/admin/accounts/:id/billing] update error:',
        error.message
      );
      return NextResponse.json(
        { error: 'Failed to update billing exemption' },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    invalidateEntitlement(id);

    return NextResponse.json({
      billing: {
        status: data.billing_status,
        planExpiresAt: data.plan_expires_at,
        trialEndsAt: data.trial_ends_at,
        exempt: data.billing_exempt,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
