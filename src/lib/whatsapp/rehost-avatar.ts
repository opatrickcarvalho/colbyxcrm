// ============================================================
// Re-host a WhatsApp-provided profile photo in our own Storage.
//
// uazapi's `/chat/details` (and the chat-list extraction endpoint)
// hand back a URL on WhatsApp's own CDN (pps.whatsapp.net). Those
// URLs are pre-signed and expire (see migration 058's comment) — so
// storing them directly in `contacts.avatar_url` eventually renders
// as a broken image. This downloads the bytes once, right after we
// get the URL from uazapi (while it's still fresh), and re-hosts
// them at a stable URL we control.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';

const BUCKET = 'whatsapp-avatars';
const MAX_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Download `remoteUrl` and re-host it at a stable path in the
 * `whatsapp-avatars` bucket, overwriting any previous photo for this
 * contact. Returns the public URL, or null on any failure (bad URL,
 * network error, unsupported/oversized image, upload error) — this
 * must never throw, since callers treat null the same as "no photo
 * available yet" and simply skip the update.
 */
export async function rehostAvatar(params: {
  remoteUrl: string;
  accountId: string;
  contactId: string;
}): Promise<string | null> {
  const { remoteUrl, accountId, contactId } = params;

  try {
    const res = await fetch(remoteUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const contentType = res.headers.get('content-type')?.split(';')[0]?.trim();
    const ext = contentType ? ALLOWED_CONTENT_TYPES[contentType] : undefined;
    if (!ext) return null;

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null;

    const path = `account-${accountId}/${contactId}.${ext}`;
    const db = supabaseAdmin();
    const { error: uploadError } = await db.storage
      .from(BUCKET)
      .upload(path, bytes, {
        cacheControl: '3600',
        upsert: true,
        contentType,
      });
    if (uploadError) {
      console.error('[rehost-avatar] upload error:', uploadError.message);
      return null;
    }

    const {
      data: { publicUrl },
    } = db.storage.from(BUCKET).getPublicUrl(path);
    return `${publicUrl}?v=${Date.now()}`;
  } catch (err) {
    console.error(
      '[rehost-avatar] failed to fetch/rehost:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
