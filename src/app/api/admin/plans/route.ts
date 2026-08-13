import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { isAsaasCycle } from '@/lib/billing/cycles';

/**
 * GET /api/admin/plans
 *
 * Platform-admin only. Every plan — active or not, public or
 * admin-only — because the operator console has to manage the whole
 * catalogue, not just what customers currently see. Same posture as
 * /api/admin/accounts: service-role client, RLS bypassed on purpose.
 */
export async function GET() {
  try {
    await requirePlatformAdmin();
    const db = supabaseAdmin();

    const { data, error } = await db
      .from('plans')
      .select(
        'id, slug, name, description, price_cents, currency, cycle, trial_days, is_active, is_public, sort_order, created_at, updated_at'
      )
      .order('sort_order', { ascending: true });

    if (error) {
      console.error('[GET /api/admin/plans] list error:', error.message);
      return NextResponse.json(
        { error: 'Failed to load plans' },
        { status: 500 }
      );
    }

    return NextResponse.json({ plans: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

interface CreatePlanBody {
  slug?: unknown;
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
 * POST /api/admin/plans
 *
 * Creates one catalogue row. `slug` is the stable handle the pricing
 * page and self-serve checkout key off (053) — unique, immutable once
 * created (this route's PATCH sibling doesn't accept it).
 */
export async function POST(request: Request) {
  try {
    await requirePlatformAdmin();

    const body = (await request.json().catch(() => ({}))) as CreatePlanBody;
    const {
      slug,
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

    if (typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug)) {
      return NextResponse.json(
        { error: 'slug is required and must be lowercase letters, numbers or dashes' },
        { status: 400 }
      );
    }
    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (typeof priceCents !== 'number' || !Number.isFinite(priceCents) || priceCents < 0) {
      return NextResponse.json(
        { error: 'priceCents must be a non-negative number' },
        { status: 400 }
      );
    }
    if (!isAsaasCycle(cycle)) {
      return NextResponse.json({ error: 'Invalid billing cycle' }, { status: 400 });
    }

    const db = supabaseAdmin();
    const { data, error } = await db
      .from('plans')
      .insert({
        slug,
        name: name.trim(),
        description:
          typeof description === 'string' && description.trim()
            ? description.trim()
            : null,
        price_cents: Math.round(priceCents),
        currency: typeof currency === 'string' && currency ? currency : 'BRL',
        cycle,
        trial_days:
          typeof trialDays === 'number' && trialDays >= 0
            ? Math.round(trialDays)
            : 0,
        is_active: isActive !== false,
        is_public: isPublic !== false,
        sort_order: typeof sortOrder === 'number' ? Math.round(sortOrder) : 0,
      })
      .select(
        'id, slug, name, description, price_cents, currency, cycle, trial_days, is_active, is_public, sort_order'
      )
      .maybeSingle();

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'A plan with this slug already exists', code: 'slug_taken' },
          { status: 409 }
        );
      }
      console.error('[POST /api/admin/plans] insert error:', error.message);
      return NextResponse.json(
        { error: 'Failed to create plan' },
        { status: 500 }
      );
    }

    return NextResponse.json({ plan: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
