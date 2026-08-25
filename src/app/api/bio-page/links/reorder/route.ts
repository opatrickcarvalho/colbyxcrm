import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

// Batched position save. NOTE: this used to be a single upsert() —
// reverted after it turned out Postgres validates NOT NULL columns
// (type, label — not present in the reorder payload) against the
// candidate row BEFORE conflict detection even for an ON CONFLICT DO
// UPDATE, so every reorder silently 500'd (23502 null-value error).
// Plain per-row UPDATEs sidestep that entirely — these ids always
// pre-exist (links are created via POST first), so there's no INSERT
// path to worry about, only `position` changes, and a handful of
// parallel round-trips is fine at bio-page-link scale.
export async function PATCH(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent');

    const body = await request.json().catch(() => null);
    const positions = (body as { positions?: { id: string; position: number }[] } | null)
      ?.positions;
    if (!Array.isArray(positions) || positions.length === 0) {
      return NextResponse.json({ error: 'positions is required' }, { status: 400 });
    }

    const results = await Promise.all(
      positions.map(({ id, position }) =>
        supabase
          .from('bio_page_links')
          .update({ position })
          .eq('id', id)
          .eq('account_id', accountId)
      )
    );

    const failed = results.find((r) => r.error);
    if (failed) {
      console.error('[PATCH /api/bio-page/links/reorder] error:', failed.error);
      return NextResponse.json({ error: 'Failed to reorder links' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
