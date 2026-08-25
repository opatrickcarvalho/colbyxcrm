// ============================================================
// WhatsApp Business label writes — thin glue between the
// `/api/conversations/[id]/labels` and `/api/whatsapp/labels` routes
// and the UAZAPI provider calls (listLabels/editLabel/setChatLabels
// in providers/uazapi.ts). Kept separate from uazapi-groups.ts's
// `resolveGroupCredentials` despite the near-identical shape — same
// "deliberately parallel, not shared" call the codebase already makes
// for group broadcasts (migration 044) vs. regular broadcasts.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { setChatLabels } from '@/lib/whatsapp/providers';

export class LabelsNotAvailableError extends Error {
  constructor() {
    super('WhatsApp Business labels require a UAZAPI-connected number.');
    this.name = 'LabelsNotAvailableError';
  }
}

/** Load + decrypt the account's UAZAPI credentials for a label action. */
export async function resolveLabelCredentials(
  supabase: SupabaseClient,
  accountId: string
): Promise<{ host: string; token: string }> {
  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('provider, uazapi_host, uazapi_instance_token')
    .eq('account_id', accountId)
    .maybeSingle();

  if (
    !config ||
    config.provider !== 'uazapi' ||
    !config.uazapi_host ||
    !config.uazapi_instance_token
  ) {
    throw new LabelsNotAvailableError();
  }

  return {
    host: config.uazapi_host as string,
    token: decrypt(config.uazapi_instance_token as string),
  };
}

/** The E.164 phone number `setChatLabels` needs, for a conversation's contact. */
export async function resolveConversationPhone(
  supabase: SupabaseClient,
  conversationId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('conversations')
    .select('contact:contacts(phone)')
    .eq('id', conversationId)
    .maybeSingle();
  const contact = data?.contact as
    { phone?: string } | { phone?: string }[] | null;
  if (!contact) return null;
  return Array.isArray(contact)
    ? (contact[0]?.phone ?? null)
    : (contact.phone ?? null);
}

export type TagLabelSyncResult = 'applied' | 'skipped' | 'failed';

/**
 * If `tagId` has a linked WhatsApp Business label (tags.whatsapp_label_id,
 * 072_tags_whatsapp_label_and_campaign_tag.sql), push that label onto
 * `contactId`'s WhatsApp chat and mirror it into
 * `conversation_whatsapp_labels` — the same two writes
 * `syncStageLabel` does in `/api/deals/[id]/move`, just triggered by a
 * tag instead of a pipeline-stage move.
 *
 * Best-effort by design: called right after a CRM tag write succeeds,
 * and a WhatsApp/UAZAPI hiccup here must never make that tag write
 * look like it failed. Callers that don't need the outcome can ignore
 * the return value.
 *
 * Relies on this codebase's one-conversation-per-(account,contact)
 * convention (see resolveConversationByPhone) — a contact-level tag
 * and a conversation-level label are otherwise different granularities,
 * but here they always resolve to the same single conversation.
 */
export async function applyTagWhatsappLabel(
  supabase: SupabaseClient,
  accountId: string,
  contactId: string,
  tagId: string
): Promise<TagLabelSyncResult> {
  try {
    const { data: tag } = await supabase
      .from('tags')
      .select('whatsapp_label_id')
      .eq('id', tagId)
      .maybeSingle();
    const whatsappLabelId = tag?.whatsapp_label_id as string | null | undefined;
    if (!whatsappLabelId) return 'skipped';

    const { data: label } = await supabase
      .from('whatsapp_labels')
      .select('uazapi_label_id')
      .eq('id', whatsappLabelId)
      .maybeSingle();
    if (!label?.uazapi_label_id) return 'skipped';

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

    await setChatLabels(host, token, {
      number: contact.phone,
      add_labelid: label.uazapi_label_id,
    });
    await supabase.from('conversation_whatsapp_labels').upsert(
      { conversation_id: conversation.id, whatsapp_label_id: whatsappLabelId },
      { onConflict: 'conversation_id,whatsapp_label_id' }
    );

    return 'applied';
  } catch (err) {
    console.error(
      '[applyTagWhatsappLabel] failed:',
      err instanceof Error ? err.message : err
    );
    return 'failed';
  }
}
