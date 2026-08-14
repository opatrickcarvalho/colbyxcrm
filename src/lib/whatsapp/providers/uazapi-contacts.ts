// ============================================================
// UAZAPI chat listing — `POST /chat/find` (vendored OpenAPI spec,
// `uazapi-openapi-spec.yaml`, tag "Chats"), used to pull every 1:1
// conversation the connected number has ever had into the CRM's
// contacts list ("extract contacts from the inbox"). Meta's Cloud API
// has no equivalent surface (it never sees a chat list, only
// individual message events), so this is UAZAPI-only — same reasoning
// as the group management functions in uazapi-groups.ts.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { jidToPhone } from '@/lib/whatsapp/phone-utils';
import { uazapiFetch } from './uazapi';

/** Thrown when the account has no live UAZAPI connection — chat
 *  listing has no Meta equivalent, so there's nothing to fall back to. */
export class ContactsExtractionNotAvailableError extends Error {
  constructor() {
    super(
      'Extracting contacts from the inbox requires a UAZAPI-connected WhatsApp number.'
    );
    this.name = 'ContactsExtractionNotAvailableError';
  }
}

/** Load + decrypt the account's UAZAPI credentials for a chat-listing call. */
export async function resolveContactsExtractionCredentials(
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
    throw new ContactsExtractionNotAvailableError();
  }

  return {
    host: config.uazapi_host as string,
    token: decrypt(config.uazapi_instance_token as string),
  };
}

export interface UazapiChatContact {
  chatId: string;
  phone: string;
  name: string;
  imageUrl?: string;
}

/** Fallback for the rare chat whose `wa_chatid` doesn't parse cleanly
 *  as a PN JID — trust the API's own `phone` field instead. */
function fallbackPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
}

function readChatContact(raw: Record<string, unknown>): UazapiChatContact | null {
  const chatId = String(raw.wa_chatid ?? raw.chatid ?? '');
  const rawPhone = typeof raw.phone === 'string' ? raw.phone : '';
  const phone = jidToPhone(chatId) ?? fallbackPhone(rawPhone);
  if (!phone) return null;

  const name =
    (raw.wa_contactName as string) ||
    (raw.wa_name as string) ||
    (raw.name as string) ||
    phone;

  const imageUrl = typeof raw.image === 'string' ? raw.image : undefined;

  return { chatId, phone, name, imageUrl };
}

const PAGE_SIZE = 100;
// Safety cap on how many chats a single extraction run will walk —
// bounds one runaway request against an account with an enormous chat
// history rather than paginating forever.
const MAX_CHATS = 5000;

/**
 * Every individual (non-group) chat the connected number has, across
 * as many `/chat/find` pages as it takes (capped at {@link MAX_CHATS}).
 * `total` is uazapi's own count, for a "found N chats" summary even
 * when the walk stops early at the cap.
 */
export async function findChatContacts(
  host: string,
  token: string
): Promise<{ contacts: UazapiChatContact[]; total: number }> {
  const contacts: UazapiChatContact[] = [];
  let offset = 0;
  let total = 0;

  for (;;) {
    const payload = await uazapiFetch<{
      chats?: unknown[];
      pagination?: { totalRecords?: number };
    }>({
      host,
      path: '/chat/find',
      auth: { kind: 'token', value: token },
      body: {
        wa_isGroup: false,
        sort: '-wa_lastMsgTimestamp',
        limit: PAGE_SIZE,
        offset,
      },
    });

    const rows = payload?.chats ?? [];
    total = payload?.pagination?.totalRecords ?? Math.max(total, rows.length);

    for (const row of rows) {
      const contact = readChatContact((row ?? {}) as Record<string, unknown>);
      if (contact) contacts.push(contact);
    }

    offset += PAGE_SIZE;
    if (rows.length < PAGE_SIZE || offset >= total || contacts.length >= MAX_CHATS) {
      break;
    }
  }

  return { contacts, total };
}
