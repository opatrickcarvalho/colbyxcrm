import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

// Cast explicitly via .returns<>() because this client has no
// generated Database types, so postgrest-js can't infer whether the
// embedded relation is one-to-one or one-to-many on its own.
interface PoolGroupJoinRow {
  position: number;
  group: {
    id: string;
    name: string;
    participant_count: number;
    max_participants: number | null;
  } | null;
}

// GET/PUT the ordered pool of whatsapp_groups backing one
// whatsapp_group-type bio_page_links row. The pool is always replaced
// wholesale on PUT (delete + insert) — small lists edited as a batch
// from the dialog, not diffed row by row.

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;

    const { data: link } = await supabase
      .from('bio_page_links')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!link) {
      return NextResponse.json({ error: 'Link not found' }, { status: 404 });
    }

    const { data: pool, error } = await supabase
      .from('bio_page_link_groups')
      .select('position, group:whatsapp_groups(id, name, participant_count, max_participants)')
      .eq('link_id', id)
      .order('position', { ascending: true })
      .returns<PoolGroupJoinRow[]>();

    if (error) {
      console.error('[GET /api/bio-page/links/[id]/groups] error:', error);
      return NextResponse.json({ error: 'Failed to load groups' }, { status: 500 });
    }

    const data = (pool ?? [])
      .map((row) => (row.group ? { ...row.group, position: row.position } : null))
      .filter((g): g is NonNullable<typeof g> => g !== null);

    return NextResponse.json({ data });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;

    const { data: link } = await supabase
      .from('bio_page_links')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!link) {
      return NextResponse.json({ error: 'Link not found' }, { status: 404 });
    }

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { whatsapp_group_ids } = body as { whatsapp_group_ids?: string[] };
    if (!Array.isArray(whatsapp_group_ids) || whatsapp_group_ids.length === 0) {
      return NextResponse.json(
        { error: 'whatsapp_group_ids must be a non-empty array' },
        { status: 400 }
      );
    }
    const uniqueIds = Array.from(new Set(whatsapp_group_ids));
    if (uniqueIds.length !== whatsapp_group_ids.length) {
      return NextResponse.json(
        { error: 'whatsapp_group_ids must not contain duplicates' },
        { status: 400 }
      );
    }

    // RLS-scoped read: only resolves ids that belong to the caller's
    // own account and are still active, same ownership-check pattern
    // as ad_campaign_id validation in /api/bio-page/links.
    const { data: owned } = await supabase
      .from('whatsapp_groups')
      .select('id')
      .eq('account_id', accountId)
      .eq('status', 'active')
      .in('id', uniqueIds);

    if ((owned ?? []).length !== uniqueIds.length) {
      return NextResponse.json(
        { error: 'One or more groups not found or not active' },
        { status: 400 }
      );
    }

    const { error: deleteError } = await supabase
      .from('bio_page_link_groups')
      .delete()
      .eq('link_id', id);
    if (deleteError) {
      console.error('[PUT /api/bio-page/links/[id]/groups] delete error:', deleteError);
      return NextResponse.json({ error: 'Failed to save groups' }, { status: 500 });
    }

    const { error: insertError } = await supabase.from('bio_page_link_groups').insert(
      uniqueIds.map((whatsapp_group_id, position) => ({
        link_id: id,
        whatsapp_group_id,
        account_id: accountId,
        position,
      }))
    );
    if (insertError) {
      console.error('[PUT /api/bio-page/links/[id]/groups] insert error:', insertError);
      return NextResponse.json({ error: 'Failed to save groups' }, { status: 500 });
    }

    const { data: pool } = await supabase
      .from('bio_page_link_groups')
      .select('position, group:whatsapp_groups(id, name, participant_count, max_participants)')
      .eq('link_id', id)
      .order('position', { ascending: true })
      .returns<PoolGroupJoinRow[]>();

    const data = (pool ?? [])
      .map((row) => (row.group ? { ...row.group, position: row.position } : null))
      .filter((g): g is NonNullable<typeof g> => g !== null);

    return NextResponse.json({ data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
