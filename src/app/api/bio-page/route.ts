import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { generateCampaignCode, slugifyCampaignCode } from '@/lib/attribution/code';

// Dashboard CRUD for the account's single bio_pages row (see
// 071_bio_pages.sql). One page per account — no list endpoint needed.
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('agent');

    const { data: page, error } = await supabase
      .from('bio_pages')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle();

    if (error) {
      console.error('[GET /api/bio-page] error:', error);
      return NextResponse.json({ error: 'Failed to load bio page' }, { status: 500 });
    }

    if (!page) {
      return NextResponse.json({ data: null });
    }

    const { count: viewCount } = await supabase
      .from('bio_page_views')
      .select('id', { count: 'exact', head: true })
      .eq('bio_page_id', page.id);

    return NextResponse.json({ data: { ...page, view_count: viewCount ?? 0 } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent');

    const { count: existing } = await supabase
      .from('bio_pages')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId);
    if (existing && existing > 0) {
      return NextResponse.json(
        { error: 'This account already has a bio page' },
        { status: 409 }
      );
    }

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { display_name, slug: requestedSlug } = body as {
      display_name?: string;
      slug?: string;
    };

    if (!display_name || !display_name.trim()) {
      return NextResponse.json({ error: 'display_name is required' }, { status: 400 });
    }

    // Same authoritative-vs-negotiable slug rule as /api/ad-campaigns:
    // an operator-typed slug that's taken is a real 409; an
    // auto-derived one retries with a random suffix instead of failing.
    if (requestedSlug !== undefined && !slugifyCampaignCode(requestedSlug)) {
      return NextResponse.json(
        { error: 'slug must contain at least one letter, digit, or underscore' },
        { status: 400 }
      );
    }
    const explicitSlug = requestedSlug ? slugifyCampaignCode(requestedSlug) : '';
    const baseSlug = explicitSlug || slugifyCampaignCode(display_name) || generateCampaignCode();

    let lastError: unknown = null;
    const maxAttempts = explicitSlug ? 1 : 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const slug =
        attempt === 0 ? baseSlug : `${baseSlug}${generateCampaignCode().slice(0, 4)}`.slice(0, 30);

      const { data: page, error } = await supabase
        .from('bio_pages')
        .insert({
          account_id: accountId,
          display_name: display_name.trim(),
          slug,
        })
        .select()
        .single();

      if (!error && page) {
        return NextResponse.json({ data: { ...page, view_count: 0 } }, { status: 201 });
      }
      lastError = error;
      if (!isUniqueViolation(error)) break;
    }

    if (explicitSlug && isUniqueViolation(lastError)) {
      return NextResponse.json(
        { error: 'Esse endereço já está em uso. Escolha outro.' },
        { status: 409 }
      );
    }

    console.error('[POST /api/bio-page] insert error:', lastError);
    return NextResponse.json({ error: 'Failed to create bio page' }, { status: 500 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent');

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { display_name, bio, avatar_url, active, slug } = body as {
      display_name?: string;
      bio?: string | null;
      avatar_url?: string | null;
      active?: boolean;
      slug?: string;
    };

    const patch: Record<string, unknown> = {};
    if (display_name !== undefined) {
      if (!display_name.trim()) {
        return NextResponse.json({ error: 'display_name cannot be empty' }, { status: 400 });
      }
      patch.display_name = display_name.trim();
    }
    if (bio !== undefined) patch.bio = bio;
    if (avatar_url !== undefined) patch.avatar_url = avatar_url;
    if (active !== undefined) patch.active = Boolean(active);
    if (slug !== undefined) {
      const sanitized = slugifyCampaignCode(slug);
      if (!sanitized) {
        return NextResponse.json(
          { error: 'slug must contain at least one letter, digit, or underscore' },
          { status: 400 }
        );
      }
      patch.slug = sanitized;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    const { data: page, error } = await supabase
      .from('bio_pages')
      .update(patch)
      .eq('account_id', accountId)
      .select()
      .single();

    if (error || !page) {
      if (isUniqueViolation(error)) {
        return NextResponse.json(
          { error: 'Esse endereço já está em uso. Escolha outro.' },
          { status: 409 }
        );
      }
      console.error('[PATCH /api/bio-page] error:', error);
      return NextResponse.json({ error: 'Bio page not found' }, { status: 404 });
    }

    return NextResponse.json({ data: page });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('agent');

    const { error } = await supabase.from('bio_pages').delete().eq('account_id', accountId);

    if (error) {
      console.error('[DELETE /api/bio-page] error:', error);
      return NextResponse.json({ error: 'Failed to delete bio page' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
