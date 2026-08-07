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
