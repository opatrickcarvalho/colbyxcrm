import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  LabelsNotAvailableError,
  resolveLabelCredentials,
} from '@/lib/whatsapp/label-write';
import { setChatLabels } from '@/lib/whatsapp/providers';

/**
 * POST /api/deals/[id]/move
 *
 * Moves a deal to a new pipeline stage and, best-effort, keeps the
 * contact's WhatsApp Business label in step with it — the Kanban
 * half of the stage<->label link (pipeline_stages.whatsapp_label_id,
 * migration 055). The reverse direction (a label changed on the
 * phone moving the deal) lives in the uazapi webhook's `chat_labels`
 * handler.
 *
 * The stage move is the only thing that can fail this request. Label
 * sync is deliberately non-blocking — a WhatsApp/UAZAPI hiccup must
 * never stop a card from moving — so its outcome is reported via
 * `labelSync` in a 200 response, never as an HTTP error:
 *   - 'applied': the new stage had a linked label (and/or the old one
 *     did) and the WhatsApp side was updated.
 *   - 'skipped': nothing to sync — neither stage has a linked label,
 *     the contact has no WhatsApp conversation yet, or the account
 *     isn't UAZAPI-connected.
 *   - 'failed': a sync was attempted but the UAZAPI call errored.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: dealId } = await params;

    const body = (await request.json().catch(() => null)) as {
      stage_id?: unknown;
    } | null;
    const newStageId =
      typeof body?.stage_id === 'string' && body.stage_id.trim()
        ? body.stage_id.trim()
        : null;
    if (!newStageId) {
      return NextResponse.json({ error: 'stage_id required' }, { status: 400 });
    }

    const { data: deal, error: dealErr } = await ctx.supabase
      .from('deals')
      .select('id, stage_id, contact_id')
      .eq('id', dealId)
      .maybeSingle();
    if (dealErr) {
      console.error('[POST /api/deals/[id]/move] deal lookup error:', dealErr);
      return NextResponse.json({ error: 'Failed to load deal' }, { status: 500 });
    }
    if (!deal) {
      return NextResponse.json({ error: 'Deal not found' }, { status: 404 });
    }

    // Dropped back onto its own column — nothing to persist or sync.
    if (deal.stage_id === newStageId) {
      return NextResponse.json({ ok: true, labelSync: 'skipped' });
    }

    const { error: updateErr } = await ctx.supabase
      .from('deals')
      .update({ stage_id: newStageId })
      .eq('id', dealId);
    if (updateErr) {
      console.error('[POST /api/deals/[id]/move] update error:', updateErr);
      return NextResponse.json({ error: 'Failed to move deal' }, { status: 500 });
    }

    const labelSync = await syncStageLabel(
      ctx.supabase,
      ctx.accountId,
      deal.stage_id,
      newStageId,
      deal.contact_id
    );

    return NextResponse.json({ ok: true, labelSync });
  } catch (error) {
    return toErrorResponse(error);
  }
}

type LabelSyncResult = 'applied' | 'skipped' | 'failed';

async function syncStageLabel(
  supabase: SupabaseClient,
  accountId: string,
  oldStageId: string,
  newStageId: string,
  contactId: string | null
): Promise<LabelSyncResult> {
  try {
    const { data: stages } = await supabase
      .from('pipeline_stages')
      .select('id, pipeline_id, whatsapp_label_id')
      .in('id', [oldStageId, newStageId]);

    const oldStage = (stages ?? []).find(
      (s: { id: string }) => s.id === oldStageId
    );
    const newStage = (stages ?? []).find(
      (s: { id: string }) => s.id === newStageId
    );

    const labelToAdd: string | null = newStage?.whatsapp_label_id ?? null;
    // Only unlink the OLD stage's label when it belongs to the SAME
    // pipeline as the new one — a contact can be simultaneously
    // "in progress" across independent pipelines, and moving in one
    // must never strip a label that belongs to another.
    let labelToRemove: string | null =
      oldStage && newStage && oldStage.pipeline_id === newStage.pipeline_id
        ? (oldStage.whatsapp_label_id ?? null)
        : null;
    if (labelToRemove === labelToAdd) labelToRemove = null;

    if (!labelToAdd && !labelToRemove) return 'skipped';
    if (!contactId) return 'skipped';

    const { data: contact } = await supabase
      .from('contacts')
      .select('phone')
      .eq('id', contactId)
      .maybeSingle();
    if (!contact?.phone) return 'skipped';

    const { data: conversationRows } = await supabase
      .from('conversations')
      .select('id')
      .eq('contact_id', contactId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1);
    const conversation = conversationRows?.[0] ?? null;
    if (!conversation) return 'skipped';

    let host: string;
    let token: string;
    try {
      ({ host, token } = await resolveLabelCredentials(supabase, accountId));
    } catch (err) {
      if (err instanceof LabelsNotAvailableError) return 'skipped';
      throw err;
    }

    const labelIds = [labelToAdd, labelToRemove].filter(
      (id): id is string => !!id
    );
    const { data: localLabels } = await supabase
      .from('whatsapp_labels')
      .select('id, uazapi_label_id')
      .in('id', labelIds);
    const uazapiIdFor = (id: string) =>
      (localLabels ?? []).find((l: { id: string }) => l.id === id)
        ?.uazapi_label_id as string | undefined;

    if (labelToAdd) {
      const uazapiId = uazapiIdFor(labelToAdd);
      if (uazapiId) {
        await setChatLabels(host, token, {
          number: contact.phone,
          add_labelid: uazapiId,
        });
        await supabase.from('conversation_whatsapp_labels').upsert(
          { conversation_id: conversation.id, whatsapp_label_id: labelToAdd },
          { onConflict: 'conversation_id,whatsapp_label_id' }
        );
      }
    }
    if (labelToRemove) {
      const uazapiId = uazapiIdFor(labelToRemove);
      if (uazapiId) {
        await setChatLabels(host, token, {
          number: contact.phone,
          remove_labelid: uazapiId,
        });
        await supabase
          .from('conversation_whatsapp_labels')
          .delete()
          .eq('conversation_id', conversation.id)
          .eq('whatsapp_label_id', labelToRemove);
      }
    }

    return 'applied';
  } catch (err) {
    console.error(
      '[POST /api/deals/[id]/move] label sync failed:',
      err instanceof Error ? err.message : err
    );
    return 'failed';
  }
}
