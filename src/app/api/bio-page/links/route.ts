import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isBioLinkType, type BioLinkType } from '@/lib/bio/link-types';
import { isHexColor } from '@/lib/bio/theme';

// Shape of a bio_page_link_groups row joined with its whatsapp_groups
// target. Cast explicitly via .returns<>() because this client has no
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

// CRUD for bio_page_links, scoped to the caller's single bio_pages row
// (see 071_bio_pages.sql). Mirrors /api/ad-campaigns's shape.
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('agent');

    const { data: page } = await supabase
      .from('bio_pages')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle();

    if (!page) {
      return NextResponse.json({ data: [] });
    }

    const { data: links, error } = await supabase
      .from('bio_page_links')
      .select('*')
      .eq('bio_page_id', page.id)
      .order('position', { ascending: true });

    if (error) {
      console.error('[GET /api/bio-page/links] error:', error);
      return NextResponse.json(
        { error: 'Failed to load links' },
        { status: 500 }
      );
    }

    // Small per-page list — one lightweight count query per link,
    // same reasoning as GET /api/ad-campaigns's counts. whatsapp_group
    // links also get their pool embedded here so the editor dialog
    // doesn't need a second round-trip per link.
    const withCounts = await Promise.all(
      (links ?? []).map(async (l) => {
        const { count } = await supabase
          .from('bio_page_link_clicks')
          .select('id', { count: 'exact', head: true })
          .eq('link_id', l.id);

        let groups: Array<{
          id: string;
          name: string;
          participant_count: number;
          max_participants: number | null;
          position: number;
        }> = [];
        if (l.type === 'whatsapp_group') {
          const { data: pool } = await supabase
            .from('bio_page_link_groups')
            .select(
              'position, group:whatsapp_groups(id, name, participant_count, max_participants)'
            )
            .eq('link_id', l.id)
            .order('position', { ascending: true })
            .returns<PoolGroupJoinRow[]>();
          groups = (pool ?? [])
            .map((row) => (row.group ? { ...row.group, position: row.position } : null))
            .filter((g): g is NonNullable<typeof g> => g !== null);
        }

        return { ...l, click_count: count ?? 0, groups };
      })
    );

    return NextResponse.json({ data: withCounts });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent');

    const { data: page } = await supabase
      .from('bio_pages')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle();
    if (!page) {
      return NextResponse.json(
        { error: 'Create the bio page before adding links' },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const {
      type,
      label,
      url,
      ad_campaign_id,
      icon,
      button_color,
      text_color,
      nsfw,
    } = body as {
      type?: string;
      label?: string;
      url?: string;
      ad_campaign_id?: string;
      icon?: string;
      button_color?: string;
      text_color?: string;
      nsfw?: boolean;
    };

    if (!isBioLinkType(type)) {
      return NextResponse.json({ error: 'Invalid link type' }, { status: 400 });
    }
    if (!label || !label.trim()) {
      return NextResponse.json({ error: 'label is required' }, { status: 400 });
    }
    if (button_color !== undefined && !isHexColor(button_color)) {
      return NextResponse.json(
        { error: 'button_color must be a #rrggbb hex color' },
        { status: 400 }
      );
    }
    if (text_color !== undefined && !isHexColor(text_color)) {
      return NextResponse.json(
        { error: 'text_color must be a #rrggbb hex color' },
        { status: 400 }
      );
    }

    const insert: Record<string, unknown> = {
      bio_page_id: page.id,
      account_id: accountId,
      type,
      label: label.trim(),
      icon: icon?.trim() || null,
      ...(button_color !== undefined ? { button_color } : {}),
      ...(text_color !== undefined ? { text_color } : {}),
      ...(nsfw !== undefined ? { nsfw: Boolean(nsfw) } : {}),
    };

    if (type === ('whatsapp' as BioLinkType)) {
      if (!ad_campaign_id) {
        return NextResponse.json(
          { error: 'ad_campaign_id is required for whatsapp links' },
          { status: 400 }
        );
      }
      // RLS-scoped read: only resolves if this ad_campaign belongs to
      // the caller's own account, so a foreign id comes back empty
      // rather than silently attaching another account's campaign.
      const { data: campaign } = await supabase
        .from('ad_campaigns')
        .select('id')
        .eq('id', ad_campaign_id)
        .eq('account_id', accountId)
        .maybeSingle();
      if (!campaign) {
        return NextResponse.json(
          { error: 'ad_campaign not found' },
          { status: 400 }
        );
      }
      insert.ad_campaign_id = ad_campaign_id;
      insert.url = null;
    } else if (type === ('whatsapp_group' as BioLinkType)) {
      // Destination pool is managed separately via
      // /api/bio-page/links/[id]/groups once this row has an id.
      insert.url = null;
      insert.ad_campaign_id = null;
    } else {
      if (!url || !url.trim()) {
        return NextResponse.json(
          { error: 'url is required for this link type' },
          { status: 400 }
        );
      }
      insert.url = url.trim();
      insert.ad_campaign_id = null;
    }

    const { count: linkCount } = await supabase
      .from('bio_page_links')
      .select('id', { count: 'exact', head: true })
      .eq('bio_page_id', page.id);
    insert.position = linkCount ?? 0;

    const { data: link, error } = await supabase
      .from('bio_page_links')
      .insert(insert)
      .select()
      .single();

    if (error || !link) {
      console.error('[POST /api/bio-page/links] insert error:', error);
      return NextResponse.json(
        { error: 'Failed to create link' },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { data: { ...link, click_count: 0, groups: [] } },
      { status: 201 }
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
