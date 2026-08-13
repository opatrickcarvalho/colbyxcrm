import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { isAsaasCycle } from '@/lib/billing/cycles';

interface UpdatePlanBody {
  name?: unknown;
  description?: unknown;
  priceCents?: unknown;
  currency?: unknown;
  cycle?: unknown;
  trialDays?: unknown;
  isActive?: unknown;
  isPublic?: unknown;
  sortOrder?: unknown;
}

/**
 * PATCH /api/admin/plans/[id]
 *
 * Partial update. `slug` is intentionally not accepted here — it's
 * the stable handle self-serve checkout and any external link key
 * off, so renaming it is a one-way door this route doesn't open.
 * Toggling `is_active` false is how the operator retires a plan
 * without breaking `account_subscriptions.plan_id` (ON DELETE SET
 * NULL would orphan history; this never deletes).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requirePlatformAdmin();
    const { id } = await params;

    const body = (await request.json().catch(() => ({}))) as UpdatePlanBody;
    const {
      name,
      description,
      priceCents,
      currency,
      cycle,
      trialDays,
      isActive,
      isPublic,
      sortOrder,
    } = body;

    const patch: Record<string, unknown> = {};

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return NextResponse.json({ error: 'Invalid name' }, { status: 400 });
      }
      patch.name = name.trim();
    }
    if (description !== undefined) {
      patch.description =
        typeof description === 'string' && description.trim()
          ? description.trim()
          : null;
    }
    if (priceCents !== undefined) {
      if (
        typeof priceCents !== 'number' ||
        !Number.isFinite(priceCents) ||
        priceCents < 0
      ) {
        return NextResponse.json(
          { error: 'priceCents must be a non-negative number' },
          { status: 400 }
        );
      }
      patch.price_cents = Math.round(priceCents);
    }
    if (currency !== undefined) {
      if (typeof currency !== 'string' || !currency) {
        return NextResponse.json({ error: 'Invalid currency' }, { status: 400 });
      }
      patch.currency = currency;
    }
    if (cycle !== undefined) {
      if (!isAsaasCycle(cycle)) {
        return NextResponse.json({ error: 'Invalid billing cycle' }, { status: 400 });
      }
      patch.cycle = cycle;
    }
    if (trialDays !== undefined) {
      if (typeof trialDays !== 'number' || trialDays < 0) {
        return NextResponse.json({ error: 'Invalid trialDays' }, { status: 400 });
      }
      patch.trial_days = Math.round(trialDays);
    }
    if (isActive !== undefined) patch.is_active = isActive === true;
    if (isPublic !== undefined) patch.is_public = isPublic === true;
    if (sortOrder !== undefined) {
      if (typeof sortOrder !== 'number') {
        return NextResponse.json({ error: 'Invalid sortOrder' }, { status: 400 });
      }
      patch.sort_order = Math.round(sortOrder);
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const db = supabaseAdmin();
    const { data, error } = await db
      .from('plans')
      .update(patch)
      .eq('id', id)
      .select(
        'id, slug, name, description, price_cents, currency, cycle, trial_days, is_active, is_public, sort_order'
      )
      .maybeSingle();

    if (error) {
      console.error('[PATCH /api/admin/plans/[id]] update error:', error.message);
      return NextResponse.json(
        { error: 'Failed to update plan' },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    }

    return NextResponse.json({ plan: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
