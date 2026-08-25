import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

// Batched position save — one upsert for every link, same pattern as
// PipelineSettings' stage reorder (src/components/pipelines/pipeline-settings.tsx)
// instead of N sequential UPDATEs.
export async function PATCH(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent');

    const body = await request.json().catch(() => null);
    const positions = (body as { positions?: { id: string; position: number }[] } | null)
      ?.positions;
    if (!Array.isArray(positions) || positions.length === 0) {
      return NextResponse.json({ error: 'positions is required' }, { status: 400 });
    }

    const { data: page } = await supabase
      .from('bio_pages')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle();
    if (!page) {
      return NextResponse.json({ error: 'Bio page not found' }, { status: 404 });
    }

    const rows = positions.map((p) => ({
      id: p.id,
      bio_page_id: page.id,
      account_id: accountId,
      position: p.position,
    }));

    // PostgREST's upsert only touches the columns present in the
    // payload on the ON CONFLICT UPDATE branch (untouched columns like
    // `type`/`label` are left alone) — bio_page_id/account_id are
    // included so the row still satisfies its NOT NULL columns in the
    // (never actually hit here, since ids always pre-exist) INSERT
    // branch too.
    const { error } = await supabase
      .from('bio_page_links')
      .upsert(rows, { onConflict: 'id' });

    if (error) {
      console.error('[PATCH /api/bio-page/links/reorder] error:', error);
      return NextResponse.json({ error: 'Failed to reorder links' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
