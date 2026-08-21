import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  LabelsNotAvailableError,
  resolveLabelCredentials,
} from '@/lib/whatsapp/label-write';
import { editLabel } from '@/lib/whatsapp/providers';

/**
 * PATCH/DELETE /api/whatsapp/labels/[id]
 *
 * `id` is this CRM's `whatsapp_labels.id` (uuid), resolved to uazapi's own
 * `labelid` before calling `POST /label/edit` — same id-translation the
 * sibling `/api/conversations/[id]/labels` route already does for
 * apply/remove. Writes go THROUGH uazapi first, then mirror onto the local
 * cache; `conversation_whatsapp_labels` (ON DELETE CASCADE) and
 * `pipeline_stages.whatsapp_label_id` (ON DELETE SET NULL) clean up on
 * their own when the local row is deleted (migrations 048, 055).
 */
async function loadLabel(
  ctx: Awaited<ReturnType<typeof requireRole>>,
  id: string
) {
  const { data: label, error } = await ctx.supabase
    .from('whatsapp_labels')
    .select('id, uazapi_label_id')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error || !label) return null;
  return label;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    const label = await loadLabel(ctx, id);
    if (!label) {
      return NextResponse.json({ error: 'Label not found' }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as {
      name?: string;
      color?: number;
    } | null;
    const name = body?.name?.trim();
    const color = Number(body?.color);
    if (!name || !Number.isInteger(color) || color < 0 || color > 19) {
      return NextResponse.json(
        { error: 'name and color (0-19) are required' },
        { status: 400 }
      );
    }

    const { host, token } = await resolveLabelCredentials(
      ctx.supabase,
      ctx.accountId
    );
    await editLabel(host, token, {
      labelid: label.uazapi_label_id,
      name,
      color,
      delete: false,
    });

    const { error: updateErr } = await ctx.supabase
      .from('whatsapp_labels')
      .update({ name, color_code: color, updated_at: new Date().toISOString() })
      .eq('id', label.id);
    if (updateErr) {
      console.error('[whatsapp labels] local update failed:', updateErr.message);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof LabelsNotAvailableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    const label = await loadLabel(ctx, id);
    if (!label) {
      return NextResponse.json({ error: 'Label not found' }, { status: 404 });
    }

    const { host, token } = await resolveLabelCredentials(
      ctx.supabase,
      ctx.accountId
    );
    await editLabel(host, token, {
      labelid: label.uazapi_label_id,
      delete: true,
    });

    const { error: deleteErr } = await ctx.supabase
      .from('whatsapp_labels')
      .delete()
      .eq('id', label.id);
    if (deleteErr) {
      console.error('[whatsapp labels] local delete failed:', deleteErr.message);
      return NextResponse.json(
        { error: 'Deleted on WhatsApp, but failed to update local cache' },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof LabelsNotAvailableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return toErrorResponse(error);
  }
}
