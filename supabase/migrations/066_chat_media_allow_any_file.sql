-- ============================================================
-- 066_chat_media_allow_any_file.sql
--
-- Lifts the `chat-media` bucket's MIME whitelist (set in migration 023)
-- so the composer's "document" attachment can send anything WhatsApp
-- Web itself can — a digital certificate (.pfx/.p12/.cer), a .zip, an
-- .exe, anything. The original whitelist mirrored Meta's Cloud API
-- document-type list, which is real for accounts on that provider, but
-- every account this CRM actually runs today connects through UAZAPI
-- (a personal WhatsApp number over Baileys/WhatsApp Web), which has no
-- such restriction — the phone app lets you attach any file as a
-- document. Reported directly: a user tried to send a digital
-- certificate from the CRM and the upload was rejected before it ever
-- reached WhatsApp.
--
-- `allowed_mime_types = NULL` is Storage's documented way to accept any
-- content type. The 16 MB size cap (migration 023) is untouched — this
-- is only about file TYPE, not size.
--
-- Idempotent — safe to re-run.
-- ============================================================

UPDATE storage.buckets
SET allowed_mime_types = NULL
WHERE id = 'chat-media';
