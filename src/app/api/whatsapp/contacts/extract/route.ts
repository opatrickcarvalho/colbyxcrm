import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { normalizeKey, isUniqueViolation } from '@/lib/contacts/dedupe';
import {
  findChatContacts,
  resolveContactsExtractionCredentials,
  ContactsExtractionNotAvailableError,
  type UazapiChatContact,
} from '@/lib/whatsapp/providers/uazapi-contacts';

/**
 * POST /api/whatsapp/contacts/extract
 *
 * "Extract contacts from the inbox" — pulls every 1:1 chat the
 * connected UAZAPI number has ever had (via `/chat/find`) and creates
 * a CRM contact for whichever ones aren't already on file, so the
 * account can broadcast to its whole WhatsApp history rather than only
 * the contacts added by hand. Mirrors the CSV import flow's dedupe
 * (skip-by-`phone_normalized`, chunked insert with a per-row retry on
 * a unique-violation race) but sources rows from uazapi instead of a
 * file.
 */
export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(
      `contactsExtract:${userId}`,
      RATE_LIMITS.contactsExtract
    );
    if (!limit.success) return rateLimitResponse(limit);

    let creds;
    try {
      creds = await resolveContactsExtractionCredentials(supabase, accountId);
    } catch (err) {
      if (err instanceof ContactsExtractionNotAvailableError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    let found;
    try {
      found = await findChatContacts(creds.host, creds.token);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown provider error';
      console.error(
        '[POST /api/whatsapp/contacts/extract] uazapi findChatContacts failed:',
        message
      );
      return NextResponse.json(
        { error: `WhatsApp API error: ${message}` },
        { status: 502 }
      );
    }

    // De-dupe within the fetched batch by normalized phone (keep the
    // first — chats are sorted most-recent-first, so that's also the
    // freshest name/photo if uazapi ever returns the same JID twice
    // across pages).
    const seen = new Set<string>();
    const uniqueChats = found.contacts.filter((c) => {
      const key = normalizeKey(c.phone);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Skip numbers already in this account.
    const { data: existingRows } = await supabase
      .from('contacts')
      .select('phone_normalized')
      .eq('account_id', accountId);
    const existing = new Set(
      (existingRows ?? [])
        .map((r) => (r as { phone_normalized: string | null }).phone_normalized)
        .filter((p): p is string => !!p)
    );

    const toInsert = uniqueChats.filter(
      (c) => !existing.has(normalizeKey(c.phone))
    );

    let imported = 0;
    let failed = 0;
    const chunkSize = 50;

    for (let i = 0; i < toInsert.length; i += chunkSize) {
      const chunk = toInsert.slice(i, i + chunkSize);
      // Deliberately NOT persisting `c.imageUrl` here: it's a
      // pre-signed WhatsApp CDN URL that expires (see
      // src/lib/whatsapp/rehost-avatar.ts), and re-hosting it for
      // potentially hundreds of contacts inline in this request would
      // be slow and failure-prone. The inbound webhook's own backfill
      // already re-fetches and permanently re-hosts the photo the
      // first time any message touches a contact with no avatar_url —
      // this just lets that happen naturally instead of storing a
      // URL that's doomed to 404 later.
      const rows = chunk.map((c: UazapiChatContact) => ({
        account_id: accountId,
        user_id: userId,
        phone: c.phone,
        name: c.name,
        avatar_url: null,
      }));

      const { data, error } = await supabase
        .from('contacts')
        .insert(rows)
        .select('id');

      if (error) {
        // Retry individually so one bad/racing row doesn't sink the
        // whole chunk — same backstop as the CSV import path.
        for (const row of rows) {
          const { error: singleErr } = await supabase.from('contacts').insert(row);
          if (!singleErr) imported++;
          else if (!isUniqueViolation(singleErr)) failed++;
        }
      } else {
        imported += (data ?? []).length;
      }
    }

    const skipped = found.contacts.length - imported - failed;

    return NextResponse.json({
      data: {
        found: found.contacts.length,
        imported,
        skipped,
        failed,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
