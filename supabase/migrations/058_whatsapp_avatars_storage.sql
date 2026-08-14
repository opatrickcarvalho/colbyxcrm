-- ============================================================
-- 058_whatsapp_avatars_storage.sql
--
-- Creates the `whatsapp-avatars` Storage bucket, used to permanently
-- re-host a contact's WhatsApp profile photo the first time we fetch
-- it from the provider.
--
-- Why this exists: uazapi's `/chat/details` returns a profile-photo
-- URL pointing at WhatsApp's own CDN (pps.whatsapp.net). Those URLs
-- are pre-signed and expire (an `oe`/`oh` signature pair in the query
-- string, same scheme Meta uses for Instagram/Facebook CDN links) —
-- typically hours to a few days, and unconditionally whenever the
-- contact changes their photo or privacy settings. Storing that URL
-- directly in `contacts.avatar_url` (what the code did before this
-- migration) meant every photo eventually 404s and renders as a
-- broken image in the CRM. The fix: download the bytes once and
-- re-host them here, so `contacts.avatar_url` always points at a URL
-- we control.
--
-- Public read (so <img> tags work without signed URLs), but NO write
-- policies — every write is server-side via the service-role client
-- (src/lib/whatsapp/rehost-avatar.ts), same posture as the `branding`
-- bucket (migration 057).
--
-- File path convention: whatsapp-avatars/account-<account_id>/<contact_id>.<ext>
-- — deterministic and upserted in place, so a re-fetch overwrites
-- rather than accumulating orphaned objects per contact.
--
-- Idempotent — safe to re-run.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'whatsapp-avatars',
  'whatsapp-avatars',
  TRUE,
  3145728, -- 3 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "WhatsApp avatars are publicly readable" ON storage.objects;
CREATE POLICY "WhatsApp avatars are publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'whatsapp-avatars');
