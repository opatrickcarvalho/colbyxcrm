import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  LabelsNotAvailableError,
  resolveConversationPhone,
  resolveLabelCredentials,
} from '@/lib/whatsapp/label-write';
import { setChatLabels } from '@/lib/whatsapp/providers';

async function readLabelId(request: Request): Promise<string | null> {
  const body = (await request.json().catch(() => null)) as {
    label_id?: unknown;
  } | null;
  return typeof body?.label_id === 'string' && body.label_id.trim()
    ? body.label_id.trim()
    : null;
}

/**
 * POST/DELETE /api/conversations/[id]/labels
 *
 * `label_id` is this CRM's `whatsapp_labels.id` (uuid), not uazapi's
 * own `labelid` — the route resolves one to the other so the client
 * never has to know uazapi's id scheme.
 *
 * Writes go THROUGH uazapi first (setChatLabels), then mirror onto
 * conversation_whatsapp_labels — optimistic, not authoritative; the
 * `chat_labels` webhook is what actually reconciles state, including
 * changes made directly from the phone.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return applyLabel(request, params, true);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return applyLabel(request, params, false);
}

async function applyLabel(
  request: Request,
  paramsPromise: Promise<{ id: string }>,
  add: boolean
) {
  try {
    const ctx = await requireRole('agent');
    const { id: conversationId } = await paramsPromise;
    const labelId = await readLabelId(request);
    if (!labelId) {
      return NextResponse.json({ error: 'label_id required' }, { status: 400 });
    }

    const { data: label, error: labelErr } = await ctx.supabase
      .from('whatsapp_labels')
      .select('id, uazapi_label_id')
      .eq('id', labelId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (labelErr || !label) {
      return NextResponse.json({ error: 'Label not found' }, { status: 404 });
    }

    const phone = await resolveConversationPhone(ctx.supabase, conversationId);
    if (!phone) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const { host, token } = await resolveLabelCredentials(
      ctx.supabase,
      ctx.accountId
    );
    await setChatLabels(
      host,
      token,
      add
        ? { number: phone, add_labelid: label.uazapi_label_id }
        : { number: phone, remove_labelid: label.uazapi_label_id }
    );

    if (add) {
      const { error } = await ctx.supabase
        .from('conversation_whatsapp_labels')
        .upsert(
          { conversation_id: conversationId, whatsapp_label_id: label.id },
          { onConflict: 'conversation_id,whatsapp_label_id' }
        );
      if (error) {
        console.error(
          '[conversation labels] upsert mirror failed:',
          error.message
        );
      }
    } else {
      const { error } = await ctx.supabase
        .from('conversation_whatsapp_labels')
        .delete()
        .eq('conversation_id', conversationId)
        .eq('whatsapp_label_id', label.id);
      if (error) {
        console.error(
          '[conversation labels] delete mirror failed:',
          error.message
        );
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof LabelsNotAvailableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return toErrorResponse(error);
  }
}
