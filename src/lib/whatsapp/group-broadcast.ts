import type { SupabaseClient } from '@supabase/supabase-js';
import type { WhatsAppProvider } from '@/lib/whatsapp/providers/types';

/**
 * Starting point shown as the prefilled/default pacing value when an
 * account has never saved `whatsapp_group_broadcast_settings`. Not a
 * WhatsApp-mandated number — the platform publishes no rate limits for
 * this unofficial channel, so this is a suggestion the user can change,
 * not a rule the app enforces.
 */
export const SUGGESTED_DELAY_SECONDS = 8;

export const GROUP_CONTENT_TYPES = ['text', 'image', 'document', 'audio', 'video'] as const;
export type GroupContentType = (typeof GROUP_CONTENT_TYPES)[number];
export const GROUP_MEDIA_CONTENT_TYPES = new Set<GroupContentType>([
  'image',
  'document',
  'audio',
  'video',
]);

/** Read the account's saved pacing default, falling back to the suggestion. */
export async function resolveGroupBroadcastDelaySeconds(
  supabase: SupabaseClient,
  accountId: string
): Promise<number> {
  const { data } = await supabase
    .from('whatsapp_group_broadcast_settings')
    .select('delay_seconds')
    .eq('account_id', accountId)
    .maybeSingle();
  return (data?.delay_seconds as number | undefined) ?? SUGGESTED_DELAY_SECONDS;
}

export interface GroupContentPayload {
  content_type: GroupContentType;
  content_text?: string | null;
  media_url?: string | null;
  filename?: string | null;
}

/**
 * Send text or native media to a group JID. Extracted from
 * `POST /api/whatsapp/groups/[id]/messages` so the live group-chat
 * composer and the group-broadcast cron drain share one send path
 * instead of drifting apart as two copies of the same branch.
 */
export async function sendGroupContent(
  provider: WhatsAppProvider,
  groupJid: string,
  payload: GroupContentPayload
): Promise<{ messageId: string }> {
  const { content_type, content_text, media_url, filename } = payload;

  if (content_type === 'text') {
    const result = await provider.sendText({ to: groupJid, text: content_text! });
    return { messageId: result.messageId };
  }

  const result = await provider.sendMedia({
    to: groupJid,
    kind: content_type,
    link: media_url!,
    caption: content_type === 'audio' ? undefined : content_text || undefined,
    filename: content_type === 'document' ? filename || undefined : undefined,
  });
  return { messageId: result.messageId };
}
