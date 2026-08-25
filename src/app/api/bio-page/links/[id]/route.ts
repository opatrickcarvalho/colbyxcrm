import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isBioLinkType, type BioLinkType } from '@/lib/bio/link-types';
import { isHexColor } from '@/lib/bio/theme';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const {
      label,
      url,
      ad_campaign_id,
      icon,
      active,
      type,
      button_color,
      text_color,
    } = body as {
      label?: string;
      url?: string | null;
      ad_campaign_id?: string | null;
      icon?: string | null;
      active?: boolean;
      type?: string;
      button_color?: string;
      text_color?: string;
    };

    const patch: Record<string, unknown> = {};
    if (label !== undefined) {
      if (!label.trim()) {
        return NextResponse.json(
          { error: 'label cannot be empty' },
          { status: 400 }
        );
      }
      patch.label = label.trim();
    }
    if (icon !== undefined) patch.icon = icon?.trim() || null;
    if (active !== undefined) patch.active = Boolean(active);
    if (button_color !== undefined) {
      if (!isHexColor(button_color)) {
        return NextResponse.json(
          { error: 'button_color must be a #rrggbb hex color' },
          { status: 400 }
        );
      }
      patch.button_color = button_color;
    }
    if (text_color !== undefined) {
      if (!isHexColor(text_color)) {
        return NextResponse.json(
          { error: 'text_color must be a #rrggbb hex color' },
          { status: 400 }
        );
      }
      patch.text_color = text_color;
    }

    // type/url/ad_campaign_id are changed together — the CHECK
    // constraint (bio_page_links_type_shape) requires a consistent
    // shape, so switching type without also supplying the matching
    // field would otherwise fail the update at the DB layer with an
    // opaque error.
    if (type !== undefined) {
      if (!isBioLinkType(type)) {
        return NextResponse.json(
          { error: 'Invalid link type' },
          { status: 400 }
        );
      }
      patch.type = type;
      if (type === ('whatsapp' as BioLinkType)) {
        if (!ad_campaign_id) {
          return NextResponse.json(
            { error: 'ad_campaign_id is required for whatsapp links' },
            { status: 400 }
          );
        }
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
        patch.ad_campaign_id = ad_campaign_id;
        patch.url = null;
      } else {
        if (!url || !url.trim()) {
          return NextResponse.json(
            { error: 'url is required for this link type' },
            { status: 400 }
          );
        }
        patch.url = url.trim();
        patch.ad_campaign_id = null;
      }
    } else if (url !== undefined) {
      patch.url = url;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    const { data: link, error } = await supabase
      .from('bio_page_links')
      .update(patch)
      .eq('id', id)
      .eq('account_id', accountId)
      .select()
      .single();

    if (error || !link) {
      console.error('[PATCH /api/bio-page/links/[id]] error:', error);
      return NextResponse.json({ error: 'Link not found' }, { status: 404 });
    }

    return NextResponse.json({ data: link });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;

    const { error } = await supabase
      .from('bio_page_links')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId);

    if (error) {
      console.error('[DELETE /api/bio-page/links/[id]] error:', error);
      return NextResponse.json(
        { error: 'Failed to delete link' },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
