import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

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

    const { name, message_template, active } = body as {
      name?: string;
      message_template?: string;
      active?: boolean;
    };

    const patch: Record<string, unknown> = {};
    if (name !== undefined) {
      if (!name.trim()) {
        return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 });
      }
      patch.name = name.trim();
    }
    if (message_template !== undefined) {
      if (!message_template.includes('{code}')) {
        return NextResponse.json(
          { error: 'message_template must contain the {code} placeholder' },
          { status: 400 }
        );
      }
      patch.message_template = message_template;
    }
    if (active !== undefined) patch.active = Boolean(active);

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    const { data: campaign, error } = await supabase
      .from('ad_campaigns')
      .update(patch)
      .eq('id', id)
      .eq('account_id', accountId)
      .select()
      .single();

    if (error || !campaign) {
      console.error('[PATCH /api/ad-campaigns/[id]] error:', error);
      return NextResponse.json({ error: 'Ad campaign not found' }, { status: 404 });
    }

    return NextResponse.json({ data: campaign });
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
      .from('ad_campaigns')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId);

    if (error) {
      console.error('[DELETE /api/ad-campaigns/[id]] error:', error);
      return NextResponse.json({ error: 'Failed to delete ad campaign' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
